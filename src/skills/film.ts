/**
 * pixeldojo_film — one idea in, a finished scored short film out.
 *
 * Drives the real Film Studio pipeline (the same /api/films routes the web
 * app uses; they accept the MCP's Bearer credential). Films are long-running
 * and charged per shot, so the skill is deliberately phased:
 *
 *   1. PLAN (free):     { idea } or { script }  → writes the screenplay,
 *      plans scenes/shots, returns film_id + a cost estimate. Nothing charged.
 *   2. PRODUCE (charged): { film_id, action: 'produce' } → dispatches the
 *      first frame batch. Each frame/clip is charged as it renders.
 *   3. STATUS (advances): { film_id, action: 'status' } → call every ~30s.
 *      Each call advances the pipeline: dispatches remaining frames, SAVES
 *      finished ones (a render lives 24h on the temp CDN until it is saved;
 *      the server's Frame check auto-reviews each frame,
 *      redoes clear mismatches up to 3 times with rewritten prompts, then
 *      flags still-mismatched shots for review), rolls clips four at a
 *      time, composes
 *      the scene-synced soundtrack, starts the export, and finally returns
 *      the finished film URL.
 *
 * MUSIC VIDEO mode ({ song_url, song_duration_sec }): the same routes the web
 * composer's "Music video" mode calls. POST /api/films with musicVideoMode +
 * the song (stored as the film's music stem) and the music clip engine, then
 * POST /plan straight from concept + lyrics (no script step: the song is the
 * runtime), then POST /music/slice to cut one song chunk per shot. Clips
 * lip-sync to their chunk; the export lays the original song, so no score is
 * ever composed for a music video.
 */
import { z } from 'zod';
import type { SkillContext, SkillModule, SkillResult } from './types.js';
import { SkillUploadError, uploadLocalFile } from './upload-helpers.js';

const STORY_LOOKS = ['live-action', 'anime', '3d-animation', 'noir', 'horror', 'sci-fi', 'documentary', 'western', 'romance', 'romantic-comedy', 'comedy'] as const;
const MUSIC_VIDEO_LOOKS = ['rap-video', 'neon-club', 'stage-performance', 'retro-camcorder', 'y2k-pop', 'moody-rnb', 'rock-grit', 'dream-pop', 'k-pop'] as const;
// Mirrors ALL_FILM_LOOKS in lib/film-studio/shared.ts (this package cannot
// import app code); tests/contracts/mcp-film-music-parity.test.ts pins it.
const LOOKS = [...STORY_LOOKS, ...MUSIC_VIDEO_LOOKS] as const;

/** Mirrors DEFAULT_MUSIC_CLIP_ENGINE_ID in lib/film-studio/engines.ts, the
 *  engine the web composer selects in music video mode (pinned by
 *  tests/contracts/mcp-film-music-parity.test.ts). Sent as the film's
 *  clipEngine at creation; the planner stamps it on every shot. */
export const MUSIC_CLIP_ENGINE_ID = 'minimax-h3-reference';

const InputSchema = z.object({
  idea: z
    .string()
    .max(2000)
    .optional()
    .describe('One-to-three sentence film idea. The studio writes the screenplay (free). Provide idea OR script for planning.'),
  script: z
    .string()
    .max(20000)
    .optional()
    .describe('A full screenplay to plan instead of an idea (sluglines, action lines, dialogue).'),
  look: z
    .enum(LOOKS)
    .optional()
    .describe('Visual style carried through frames, clips, and soundtrack. Default live-action, or rap-video for a music video.'),
  song_url: z
    .string()
    .url()
    .startsWith('https://')
    .max(2000)
    .optional()
    .describe('Music video mode: URL of the song, which must be your own PixelDojo upload (from pixeldojo_upload), not a third-party link. The film is cut to the song and every clip lip-syncs to its slice of it. idea describes the visuals.'),
  song_path: z
    .string()
    .max(4096)
    .optional()
    .describe('Music video mode, local server only: absolute path to the song file (MP3, WAV, M4A, AAC, OGG, FLAC up to 50MB). Uploaded for you; use instead of song_url.'),
  song_duration_sec: z
    .number()
    .positive()
    .max(7200)
    .optional()
    .describe('Music video mode (optional): the song length in seconds. Omit it and the studio measures the song.'),
  lyrics: z
    .string()
    .max(10000)
    .optional()
    .describe('Music video mode: the song lyrics, so shots land on the right lines. Optional.'),
  aspect: z.enum(['16:9', '9:16']).default('16:9'),
  length: z
    .enum(['30s', '60s', '2-3min', '5min'])
    .default('60s')
    .describe('Target length; drives the shot count (~6/12/24/60 shots).'),
  film_id: z.string().max(40).optional().describe('Existing film id (from a previous call) for produce/status.'),
  action: z
    .enum(['plan', 'produce', 'status'])
    .default('plan')
    .describe("'plan' creates + storyboards (free). 'produce' starts charged generation. 'status' advances production and reports progress; poll it every ~30s until it returns the finished film."),
  soundtrack: z
    .enum(['scene-synced', 'flat', 'none'])
    .default('scene-synced')
    .describe('scene-synced composes one musical section per scene, pinned to the scene lengths (default). flat is a single cohesive bed. none skips music.'),
  music_job_id: z
    .string()
    .max(80)
    .optional()
    .describe('The music_job_id from the previous status reply while the score is composing, so that score is attached. A status call without it, once all clips are ready and no score is attached, starts and charges for a new score.'),
});
type Input = z.infer<typeof InputSchema>;

const InputJsonSchema: Record<string, unknown> = {
  type: 'object',
  properties: {
    idea: { type: 'string', description: 'Plan step: one-to-three sentence film idea. The studio writes the screenplay (free). Provide idea or script.' },
    script: { type: 'string', description: 'Plan step: a full screenplay (sluglines, action lines, dialogue) to plan instead of an idea.' },
    look: { type: 'string', enum: [...LOOKS], description: `Plan step: visual style carried through frames, clips and soundtrack. Story looks: ${STORY_LOOKS.join(', ')} (default live-action). Music video looks: ${MUSIC_VIDEO_LOOKS.join(', ')} (default rap-video).` },
    song_url: {
      type: 'string',
      description:
        'Plan step, music video mode: URL of the song. It must be your own PixelDojo upload (from pixeldojo_upload or /api/v1/upload); a third-party link is refused. Makes a music video cut to this song, every clip lip-synced to its slice of it, rendered on the studio music video engine. idea (or script) describes the visuals. No score is composed: the song is the soundtrack.',
    },
    song_path: {
      type: 'string',
      description:
        'Plan step, music video mode: absolute local path to the song (MP3, WAV, M4A, AAC, OGG, FLAC up to 50MB). Uploaded for you; use instead of song_url.',
    },
    song_duration_sec: {
      type: 'number',
      description: 'Plan step, music video mode (optional): the song length in seconds. Omit it and the studio measures the song.',
    },
    lyrics: { type: 'string', description: 'Plan step, music video mode (optional): the song lyrics, so shots land on the right lines.' },
    aspect: { type: 'string', enum: ['16:9', '9:16'], description: 'Plan step: frame aspect ratio. Default 16:9.' },
    length: { type: 'string', enum: ['30s', '60s', '2-3min', '5min'], description: 'Plan step: target length, which sets the shot count (~6/12/24/60 shots). Default 60s. Ignored for a music video, whose length is the song.' },
    film_id: { type: 'string', description: 'The film_id returned by the plan step. Required for produce and status; with it, action "plan" is treated as "status".' },
    action: {
      type: 'string',
      enum: ['plan', 'produce', 'status'],
      description:
        'plan (default, free): writes the script and plans shots, returns film_id and a cost estimate. produce (charged): starts rendering frames. status: advances production one step and reports progress; call it every ~30s until it returns the finished film URL.',
    },
    soundtrack: {
      type: 'string',
      enum: ['scene-synced', 'flat', 'none'],
      description:
        'Read on status calls once all clips are ready. scene-synced (default): one musical section per scene. flat: one cohesive bed. none: export without music. Ignored for a music video, which always exports with its song.',
    },
    music_job_id: {
      type: 'string',
      description:
        'The music_job_id from the previous status reply while the score is composing. A status call without it, once all clips are ready and no score is attached, starts and charges for a new score.',
    },
  },
};

interface FilmShotDto {
  id: string;
  prompt: string;
  status: string;
  approved: boolean;
  frameUrl?: string;
  videoUrl?: string;
  errorMessage?: string;
  durationSec: number;
  musicChunkUrl?: string;
  characterIds: string[];
  elementIds: string[];
  engine: string;
  cameraPreset?: string;
}
interface FilmDto {
  id: string;
  title: string;
  status: string;
  look: string;
  aspect: string;
  script?: string;
  exportUrl?: string;
  exportError?: string;
  audioStems: { kind: string; url: string }[];
  musicVideoMode?: boolean;
  musicDurationSec?: number;
  /** The planner run (script writer / shot planner). Both answer 202 with a
   *  job id and finish in the background; this is what settles it. */
  llmJob?: { id: string; kind: string; status: 'running' | 'done' | 'error'; error?: string };
  scenes: { id: string; title: string; location?: string; shots: FilmShotDto[] }[];
}

/**
 * A rendered frame/clip that is still a draft. Film Studio writes fresh
 * renders to the 24h temp CDN and only an explicit save copies them to the
 * permanent one, so the host is the flag (mirrors isDraftFilmMedia in the
 * app's lib/film-studio/shared.ts — this package cannot import from it).
 */
function needsSave(url: string | undefined): boolean {
  return Boolean(url && url.startsWith('https://temp.pixeldojo.ai/'));
}

async function filmApi<T>(
  ctx: SkillContext,
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; data: T }> {
  const res = await fetch(`${ctx.baseUrl}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${ctx.apiKey}`,
      'Content-Type': 'application/json',
      'x-pixeldojo-source': `mcp/${ctx.mcpVersion}`,
      'x-pixeldojo-skill': 'film',
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const data = (await res.json().catch(() => ({}))) as T;
  return { status: res.status, data };
}

const shots = (f: FilmDto) => f.scenes.flatMap((s) => s.shots);
const count = (f: FilmDto, pred: (sh: FilmShotDto) => boolean) => shots(f).filter(pred).length;

function progressLine(f: FilmDto): string {
  const all = shots(f);
  const frames = all.filter((sh) => ['frame-ready', 'approved', 'clip-generating', 'clip-ready'].includes(sh.status) || sh.frameUrl).length;
  const clips = all.filter((sh) => sh.status === 'clip-ready').length;
  const rendering = all.filter((sh) => sh.status === 'clip-generating').length;
  return `frames ${frames}/${all.length}, clips ${clips}/${all.length}${rendering > 0 ? ` (${rendering} rendering)` : ''}`;
}

/** Planner polling inside one tool call: ~24s, under the 30s sync window the
 *  rest of the package uses. A longer run hands off to action "status". */
const PLANNER_POLL_MS = 3000;
const PLANNER_MAX_POLLS = 8;

type PlannerOutcome = { film: FilmDto } | { error: string } | { pending: true };

/** Submit a planner run (/script or /plan answer 202 { jobId }) and wait for
 *  the film's llmJob with that id to settle, like runPlannerJob in the app. */
/** `maxPolls` 0 = submit and return (a status call must answer fast; the next
 *  status picks the result up). */
async function runPlanner(
  ctx: SkillContext,
  filmId: string,
  path: string,
  body: Record<string, unknown>,
  maxPolls = PLANNER_MAX_POLLS,
): Promise<PlannerOutcome> {
  const submit = await filmApi<{ jobId?: string; film?: FilmDto; error?: string }>(ctx, 'POST', path, body);
  if (submit.data.film) return { film: submit.data.film };
  const jobId = submit.data.jobId;
  if (!jobId) return { error: submit.data.error ?? `HTTP ${submit.status}` };
  const sleep = ctx.pollOverrides?.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  for (let i = 0; i < maxPolls; i += 1) {
    await sleep(PLANNER_POLL_MS);
    const { data } = await filmApi<{ film?: FilmDto }>(ctx, 'GET', `/api/films/${filmId}`);
    const job = data.film?.llmJob;
    if (!data.film || job?.id !== jobId) continue;
    if (job.status === 'error') return { error: job.error ?? 'the run failed' };
    if (job.status === 'done') return { film: data.film };
  }
  return { pending: true };
}

/** Cut the song into one chunk per shot (free, hosted ffmpeg; can take a
 *  couple of minutes). Returns an error line, or null on success. */
async function sliceSong(ctx: SkillContext, film: FilmDto): Promise<string | null> {
  const r = await filmApi<{ error?: string }>(ctx, 'POST', `/api/films/${film.id}/music/slice`, {
    songDurationSec: film.musicDurationSec,
  });
  return r.status === 200 ? null : `Could not cut the song into shots: ${r.data.error ?? r.status}`;
}

const isMusicVideo = (f: FilmDto) => f.musicVideoMode === true;
/** Mirrors musicSyncStatus 'unsynced' in the app: no shot carries a chunk yet. */
const needsSlice = (f: FilmDto) => isMusicVideo(f) && shots(f).length > 0 && !shots(f).some((sh) => sh.musicChunkUrl);

function plannedText(film: FilmDto, ctx: SkillContext): string {
  const total = shots(film).length;
  const music = isMusicVideo(film);
  const sceneLines = film.scenes.map((s, i) => `  Scene ${i + 1} "${s.title}"${s.location ? ` [${s.location}]` : ''}: ${s.shots.length} shots`);
  return [
    `Planned ${music ? 'music video ' : ''}"${film.title}" (film_id: ${film.id}): ${film.scenes.length} scenes, ${total} shots, ${film.look}, ${film.aspect}.`,
    ...sceneLines,
    '',
    music
      ? `Nothing has been charged yet. The song is cut into one slice per shot and each clip lip-syncs to its slice on the studio music video engine. Producing renders every shot, charged as each renders. No score is composed: the export plays your song.`
      : `Nothing has been charged yet. Producing renders every shot (roughly 35-40 credits per 5-second shot at default engines, charged as each renders) plus a few credits for the soundtrack.`,
    `Review or edit at ${ctx.baseUrl}/film-studio/${film.id}, or call pixeldojo_film with {"film_id": "${film.id}", "action": "produce"} to start production.`,
  ].join('\n');
}

const stillPlanningText = (filmId: string, stage: 'script' | 'plan' = 'plan') =>
  `${stage === 'script' ? 'Still writing the script' : 'Still planning the shots'} for film_id ${filmId}. Nothing has been charged. Call pixeldojo_film with {"film_id": "${filmId}", "action": "status"} in ~30s; it returns the plan once it is ready.`;

async function plan(input: Input, ctx: SkillContext): Promise<SkillResult> {
  const music = Boolean(input.song_url || input.song_path);
  if (!input.idea?.trim() && !input.script?.trim()) {
    return {
      kind: 'text',
      text: music
        ? 'Provide an `idea` describing the visuals of the music video (plus optional `lyrics`).'
        : 'Provide an `idea` (we write the script, free) or a full `script` to plan a film.',
    };
  }
  if (input.song_path && !input.song_url) {
    try {
      input = { ...input, song_url: await uploadLocalFile(input.song_path, ctx) };
    } catch (err) {
      if (err instanceof SkillUploadError) return { kind: 'text', text: `Could not upload the song: ${err.userMessage}` };
      throw err;
    }
  }
  const created = await filmApi<{ film?: FilmDto; error?: string }>(ctx, 'POST', '/api/films', {
    aspect: input.aspect,
    look: input.look ?? (music ? MUSIC_VIDEO_LOOKS[0] : 'live-action'),
    lengthTarget: input.length,
    assetIds: [],
    ...(music
      ? {
          // No script step names a music video, so it would stay "Untitled film".
          ...(input.idea?.trim() ? { title: input.idea.trim().slice(0, 80) } : {}),
          musicVideoMode: true,
          musicUrl: input.song_url,
          ...(input.song_duration_sec ? { musicDurationSec: input.song_duration_sec } : {}),
          clipEngine: MUSIC_CLIP_ENGINE_ID,
        }
      : {}),
  });
  if (!created.data.film) return { kind: 'text', text: `Could not create the film: ${created.data.error ?? created.status}` };
  const id = created.data.film.id;

  let planned: PlannerOutcome;
  if (music) {
    // No script step: the planner reads the concept + lyrics directly, and
    // no fitToScript, since the SONG sets the runtime (web composer parity).
    const brief = [input.idea?.trim() || input.script!.trim(), input.lyrics?.trim() ? `Lyrics:\n${input.lyrics.trim()}` : '']
      .filter(Boolean)
      .join('\n\n');
    planned = await runPlanner(ctx, id, `/api/films/${id}/plan`, { script: brief });
  } else {
    let script = input.script?.trim() ?? '';
    if (!script) {
      const wrote = await runPlanner(ctx, id, `/api/films/${id}/script`, { idea: input.idea!.trim() });
      if ('pending' in wrote) return { kind: 'text', text: stillPlanningText(id, 'script') };
      if ('error' in wrote) return { kind: 'text', text: `Script writing failed: ${wrote.error}` };
      script = wrote.film.script ?? '';
      if (!script) return { kind: 'text', text: 'Script writing failed: the studio returned an empty script.' };
    }
    planned = await runPlanner(ctx, id, `/api/films/${id}/plan`, { script });
  }
  if ('pending' in planned) return { kind: 'text', text: stillPlanningText(id) };
  if ('error' in planned) return { kind: 'text', text: `Shot planning failed: ${planned.error}` };

  const film = planned.film;
  if (needsSlice(film)) {
    const err = await sliceSong(ctx, film);
    if (err) return { kind: 'text', text: `${plannedText(film, ctx)}\n\n${err} Call action "status" to retry the cut.` };
  }
  return { kind: 'text', text: plannedText(film, ctx) };
}

/** A film whose planning has not landed a storyboard yet: report the running
 *  run, or (re)submit the shot plan from the stored script. Null = planned. */
async function resumePlanning(film: FilmDto, ctx: SkillContext): Promise<SkillResult | null> {
  if (film.scenes.length > 0 && film.llmJob?.status !== 'running') return null;
  if (film.llmJob?.status === 'running') {
    return { kind: 'text', text: stillPlanningText(film.id, film.llmJob.kind === 'script' ? 'script' : 'plan') };
  }
  const prior = film.llmJob?.status === 'error' ? `The last planning run failed (${film.llmJob.error ?? 'unknown'}). ` : '';
  if (!film.script?.trim()) {
    return { kind: 'text', text: `${prior}This film has nothing to plan from. Start a new one with action "plan".` };
  }
  const planned = await runPlanner(ctx, film.id, `/api/films/${film.id}/plan`, { script: film.script }, 0);
  if ('pending' in planned) return { kind: 'text', text: `${prior}${stillPlanningText(film.id)}` };
  if ('error' in planned) return { kind: 'text', text: `Shot planning failed: ${planned.error} Call action "status" to retry.` };
  if (needsSlice(planned.film)) {
    const err = await sliceSong(ctx, planned.film);
    if (err) return { kind: 'text', text: `${plannedText(planned.film, ctx)}\n\n${err} Call action "status" to retry the cut.` };
  }
  return { kind: 'text', text: plannedText(planned.film, ctx) };
}

async function produce(filmId: string, ctx: SkillContext): Promise<SkillResult> {
  const { data } = await filmApi<{ film?: FilmDto; error?: string }>(ctx, 'GET', `/api/films/${filmId}`);
  if (!data.film) return { kind: 'text', text: `Film not found: ${data.error ?? filmId}` };
  const planning = await resumePlanning(data.film, ctx);
  if (planning) return planning;
  const pending = shots(data.film).filter((sh) => sh.status === 'idle' || (sh.status === 'failed' && !sh.frameUrl));
  let fired = 0;
  for (const sh of pending.slice(0, 6)) {
    const r = await filmApi(ctx, 'POST', `/api/films/${filmId}/shots/${sh.id}/generate`, { kind: 'frame' });
    if (r.status === 200) fired += 1;
  }
  return {
    kind: 'text',
    text: `Production started on "${data.film.title}": ${fired} frame(s) dispatched (each is a normal frame charge; the server's Frame check reviews every one). Poll pixeldojo_film with {"film_id": "${filmId}", "action": "status"} every ~30 seconds — each poll advances the pipeline.`,
  };
}

const LOOK_MUSIC: Record<string, string> = {
  'live-action': 'modern cinematic underscore, warm strings and soft felt piano, subtle rhythmic pulse, slow emotional build',
  anime: 'sweeping anime film score, lush strings and piano, taiko drum accents, soaring heartfelt theme',
  '3d-animation': 'playful heartfelt family-animation score, pizzicato strings, celesta and warm woodwinds, gentle sense of wonder',
  noir: 'smoky film-noir jazz underscore, brushed drums, upright bass, distant muted trumpet, slow simmering tension',
  horror: 'sparse horror underscore, low cello drones, dissonant string swells, creeping heartbeat pulse, unsettling quiet',
  'sci-fi': 'atmospheric science-fiction score, analog synth pads, deep sub-bass pulses, shimmering arpeggios, vast and cold',
  documentary: 'understated documentary score, felt piano, soft string beds, organic percussion textures, reflective and true',
  western: 'cinematic western score, lonely twangy guitar, dusty strings, distant horns, wide-open desert tension',
  romance: 'tender romantic score, felt piano and warm strings, soft acoustic guitar, intimate and unhurried, gently swelling',
  'romantic-comedy': 'bright romantic-comedy score, plucky ukulele and handclaps, warm brushed drums, sunny and flirtatious',
  comedy: 'playful comedy score, bouncy pizzicato strings, cheeky woodwinds, light percussion hits punctuating the gags',
};
const ARC = {
  opening: ['establishing the theme', 'restrained', 'quiet anticipation'],
  middle: ['building tension', 'rising intensity', 'forward motion'],
  finale: ['climactic', 'full arrangement', 'emotional peak resolving to stillness'],
};

/** Mirrors the studio's scene-synced plan: one section per scene, pinned to
 *  the scene runtime, arc styles by position. */
function buildScorePlanBody(film: FilmDto): Record<string, unknown> {
  const scenes = film.scenes.filter((s) => s.shots.length > 0);
  const sections = scenes.flatMap((scene, i) => {
    const runtime = Math.max(3000, scene.shots.reduce((n, sh) => n + (sh.durationSec || 0), 0) * 1000);
    const styles = i === 0 ? ARC.opening : i === scenes.length - 1 ? ARC.finale : ARC.middle;
    const parts = Math.max(1, Math.ceil(runtime / 120000));
    const partMs = Math.round(runtime / parts);
    return Array.from({ length: parts }, (_, part) => ({
      section_name: parts > 1 ? `${scene.title} (part ${part + 1})` : scene.title,
      positive_local_styles: styles,
      negative_local_styles: [],
      duration_ms: part === parts - 1 ? runtime - partMs * (parts - 1) : partMs,
      lines: [],
    }));
  });
  return {
    composition_plan: {
      positive_global_styles: (LOOK_MUSIC[film.look] ?? LOOK_MUSIC['live-action']).split(', '),
      negative_global_styles: ['vocals', 'singing', 'lyrics'],
      sections,
    },
    respect_sections_durations: true,
    output_format: 'mp3_standard',
  };
}

function buildFlatMusicBody(film: FilmDto, all: FilmShotDto[]): Record<string, unknown> {
  const runtimeSec = all.reduce((n, sh) => n + (sh.durationSec || 0), 0);
  // The tool's window is 30s–5min; outside it the schema 400s.
  const ms = Math.min(300000, Math.max(30000, Math.ceil((runtimeSec * 1000) / 5000) * 5000));
  return {
    prompt: `${LOOK_MUSIC[film.look] ?? LOOK_MUSIC['live-action']}. Instrumental only, no vocals. One consistent theme, loopable as a background bed under dialogue.`,
    music_length_ms: ms,
    force_instrumental: true,
    output_format: 'mp3_standard',
  };
}

async function advance(filmId: string, soundtrack: Input['soundtrack'], musicJobId: string | undefined, ctx: SkillContext): Promise<SkillResult> {
  const { data } = await filmApi<{ film?: FilmDto; error?: string }>(ctx, 'GET', `/api/films/${filmId}?refresh=1`);
  const film = data.film;
  if (!film) return { kind: 'text', text: `Film not found: ${data.error ?? filmId}` };
  const all = shots(film);

  // Finished?
  if (film.status === 'exported' && film.exportUrl) {
    return {
      kind: 'text',
      text: `Film finished: "${film.title}"\nWatch/download: ${film.exportUrl}\nWorkspace: ${ctx.baseUrl}/film-studio/${film.id}\nIt is saved in the Library folder "Film: ${film.title}".`,
    };
  }
  if (film.exportError) {
    return { kind: 'text', text: `Export failed: ${film.exportError} Poll again with action "status" to retry.` };
  }
  const planning = await resumePlanning(film, ctx);
  if (planning) return planning;
  // A music video's clips lip-sync to their slice of the song, and a clip
  // rendered before the cut has no slice to sing to. The cut is free.
  if (needsSlice(film)) {
    const err = await sliceSong(ctx, film);
    if (err) return { kind: 'text', text: `${err} Poll again with action "status" to retry.` };
    return { kind: 'text', text: `Song cut into one slice per shot. Poll again with {"film_id": "${filmId}", "action": "status"} to keep production moving.` };
  }
  // Planned but never produced: report the plan. Only `produce` starts
  // charging, so a status poll on a fresh plan must not dispatch frames.
  if (shots(film).length > 0 && shots(film).every((sh) => sh.status === 'idle')) {
    return { kind: 'text', text: plannedText(film, ctx) };
  }

  // 1) Frames: dispatch idle, save finished ones.
  const idleFrames = all.filter((sh) => sh.status === 'idle');
  for (const sh of idleFrames.slice(0, 6)) {
    await filmApi(ctx, 'POST', `/api/films/${filmId}/shots/${sh.id}/generate`, { kind: 'frame' });
  }
  const framesDone = all.every((sh) => ['frame-ready', 'clip-generating', 'clip-ready'].includes(sh.status));
  if (framesDone && all.some((sh) => sh.status === 'frame-ready' && needsSave(sh.frameUrl))) {
    // Save every rendered frame. A frame renders onto the 24h temp CDN and is
    // deleted unless it is saved, and the clip dispatch below refuses to start
    // from a draft — this is the step that keeps the storyboard. The old
    // `approved: true` merge-PATCH no longer does it: approval is a flag, and
    // saving moves bytes.
    await filmApi(ctx, 'POST', `/api/films/${filmId}/save`, { kind: 'frame' });
  }

  // 2) Clips: keep four in flight; retry audio-check failures once per poll.
  const inFlight = count(film, (sh) => sh.status === 'clip-generating');
  const clipQueue = all.filter((sh) => (sh.status === 'frame-ready' || (sh.status === 'failed' && Boolean(sh.frameUrl))) && framesDone);
  for (const sh of clipQueue.slice(0, Math.max(0, 4 - inFlight))) {
    await filmApi(ctx, 'POST', `/api/films/${filmId}/shots/${sh.id}/generate`, { kind: 'clip' });
  }

  // 3) All clips ready → save them, then soundtrack (once), then export.
  const clipsDone = all.length > 0 && all.every((sh) => sh.status === 'clip-ready');
  if (clipsDone) {
    // Same 24h clock as frames, and the export refuses to stitch a draft clip
    // (blocker reason 'needs-save'). Saving also files each clip into the
    // film's Library folder, which is where this skill tells the caller to
    // look for them.
    if (all.some((sh) => needsSave(sh.videoUrl))) {
      await filmApi(ctx, 'POST', `/api/films/${filmId}/save`, { kind: 'clip' });
    }
    const hasMusic = film.audioStems.some((st) => st.kind === 'music');
    // A music video's song IS the soundtrack (the export mutes the clips and
    // lays it): never compose, and never charge, a score for one.
    if (soundtrack !== 'none' && !hasMusic && !isMusicVideo(film)) {
      // A previous poll started the score — attach it when done.
      if (musicJobId) {
        const job = await ctx.client.getJob(musicJobId);
        // `audio` is in the live API response; older @pixeldojo/sdk type
        // versions predate the field, so read it structurally.
        const out = job.output as { audio?: string; video?: string; images?: string[] } | undefined;
        const outUrl = out?.audio ?? out?.video ?? out?.images?.[0];
        if (job.status === 'completed' && typeof outUrl === 'string') {
          await filmApi(ctx, 'PATCH', `/api/films/${filmId}`, { audioStems: [{ kind: 'music', url: outUrl }] });
          await filmApi(ctx, 'POST', `/api/films/${filmId}/export`, {});
          return { kind: 'text', text: `Score attached — export started. Poll again in ~60s with {"film_id": "${filmId}", "action": "status"} for the finished film URL.` };
        }
        if (job.status === 'failed') {
          return { kind: 'text', text: `The score failed (${job.error ?? 'unknown'}) and was refunded. Poll again to retry, or pass soundtrack "none" to export without music.` };
        }
        return { kind: 'text', text: `Score still composing. Poll again in ~20s with {"film_id": "${filmId}", "action": "status", "music_job_id": "${musicJobId}"}.` };
      }
      // Dispatch the score through the public API (same engine as the studio).
      const body = soundtrack === 'scene-synced' ? buildScorePlanBody(film) : buildFlatMusicBody(film, all);
      const dispatch = await ctx.client.run('text-to-music', body as never);
      return { kind: 'text', text: `All ${all.length} clips ready — the ${soundtrack} score is composing (charged like any music generation). Poll again in ~20s with {"film_id": "${filmId}", "action": "status", "music_job_id": "${dispatch.jobId}"}.` };
    }
    await filmApi(ctx, 'POST', `/api/films/${filmId}/export`, {});
    return { kind: 'text', text: `All clips ready — export started (${progressLine(film)}). Poll again in ~60s with action "status" for the finished film URL.` };
  }

  const failed = all.filter((sh) => sh.status === 'failed');
  return {
    kind: 'text',
    text: [
      `In progress: ${progressLine(film)}.`,
      failed.length > 0 ? `${failed.length} shot(s) failed and were re-queued (${failed[0]?.errorMessage?.slice(0, 100) ?? ''}).` : '',
      `Poll again in ~30s with {"film_id": "${filmId}", "action": "status"}.`,
    ].filter(Boolean).join('\n'),
  };
}

async function run(input: Input, ctx: SkillContext): Promise<SkillResult> {
  const action = input.action === 'plan' && input.film_id ? 'status' : input.action;
  if (action === 'plan') return plan(input, ctx);
  if (!input.film_id) return { kind: 'text', text: 'produce/status need the film_id returned by the plan step.' };
  if (action === 'produce') return produce(input.film_id, ctx);
  return advance(input.film_id, input.soundtrack, input.music_job_id, ctx);
}

export const filmSkill: SkillModule<Input> = {
  name: 'pixeldojo_film',
  description:
    'Make a finished short film from one idea: screenplay, storyboard frames (AI-reviewed), video clips with spoken dialogue, scene-synced soundtrack, stitched export. Or a music video: pass song_path (a local file) or song_url (your own PixelDojo upload from pixeldojo_upload, never a third-party link) with optional lyrics; the film is cut to that song, each clip lip-synced to its slice on the studio music video engine, and no score is composed: the export plays the song. Phased: plan is free; produce starts charged generation; status advances production (poll every ~30s).',
  hostedDescription:
    'Make a finished short film from one idea: screenplay, storyboard frames (AI-reviewed), video clips with spoken dialogue, scene-synced soundtrack, stitched export. Or a music video: pass song_url (your own PixelDojo upload made with POST /api/v1/upload, never a third-party link) with optional lyrics; the film is cut to that song, each clip lip-synced to its slice on the studio music video engine, and no score is composed: the export plays the song. Phased: plan is free; produce starts charged generation; status advances production (poll every ~30s).',
  inputZod: InputSchema as unknown as z.ZodType<Input>,
  inputJsonSchema: InputJsonSchema,
  allowedModels: [],
  defaultModel: '',
  run,
};
