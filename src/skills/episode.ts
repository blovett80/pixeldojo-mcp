/**
 * pixeldojo_episode — one topic in, a finished narrated faceless video out.
 *
 * Drives the real Faceless Studio pipeline (the same
 * /api/faceless-studio/episodes routes the web app uses; they accept the
 * MCP's Bearer credential). Phased like pixeldojo_film:
 *
 *   1. CREATE (free):  { topic } → creates the episode, writes the script and
 *      scene plan, returns episode_id and the credit quote. Nothing charged.
 *   2. PRODUCE (charged, advances one step per call):
 *      narration → scene renders (four at a time) → music bed → export →
 *      save. Every charged step says what it cost. Call it every ~30s until it
 *      returns the finished video URL.
 *   3. STATUS (free, read-only): progress and the current quote.
 *
 * Rendering happens server-side (the `.../generate` routes), so the charge
 * for each render is the same tool at the same price the web app uses.
 */
import { z } from 'zod';
import type { SkillContext, SkillModule, SkillResult } from './types.js';

// Mirrors of the studio's constants (lib/faceless-studio/shared.ts). This
// package cannot import the app, so tests/contracts/mcp-episode-parity.test.ts
// pins these to the originals.
const STYLES = ['editorial-motion', 'paper-diorama', 'hand-drawn', 'storybook', 'poster-vector', 'soft-3d'] as const;
const CATEGORIES = ['education', 'history', 'kids', 'storytelling', 'custom'] as const;
const ENGINES = ['omni-draft', 'omni-final', 'still-motion'] as const;
const MIN_SECONDS = 60;
const MAX_SECONDS = 300;

/** Scene renders in flight at once, same as the web page's queue. */
const MAX_IN_FLIGHT = 4;

const InputSchema = z.object({
  action: z.enum(['create', 'produce', 'status']).default('create'),
  topic: z.string().min(8).max(400).optional(),
  episode_id: z.string().max(40).optional(),
  category: z.enum(CATEGORIES).default('education'),
  style: z.enum(STYLES).default('editorial-motion'),
  aspect: z.enum(['16:9', '9:16']).default('16:9'),
  length_seconds: z.number().int().min(MIN_SECONDS).max(MAX_SECONDS).default(120),
  voice: z.string().min(1).max(80).default('Wise_Woman'),
  engine: z.enum(ENGINES).optional(),
  music: z.boolean().default(true),
  title: z.string().max(120).optional(),
});
type Input = z.infer<typeof InputSchema>;

const InputJsonSchema: Record<string, unknown> = {
  type: 'object',
  properties: {
    action: {
      type: 'string',
      enum: ['create', 'produce', 'status'],
      description:
        'create (default, free): writes the script and scene plan, returns episode_id and the credit quote. produce (charged): advances production one step (narration, scene renders, music, export, save) and reports what that step cost; call it every ~30s until it returns the finished video URL. status (free): progress only.',
    },
    topic: { type: 'string', description: 'Create step: what the episode is about, 8 to 400 characters.' },
    episode_id: { type: 'string', description: 'The episode_id from the create step. Required for produce and status.' },
    category: { type: 'string', enum: [...CATEGORIES], description: 'Create step: tone of the script. Default education.' },
    style: { type: 'string', enum: [...STYLES], description: 'Create step: visual style of every scene. Default editorial-motion.' },
    aspect: { type: 'string', enum: ['16:9', '9:16'], description: 'Create step: 16:9 landscape (default) or 9:16 vertical.' },
    length_seconds: { type: 'integer', minimum: MIN_SECONDS, maximum: MAX_SECONDS, description: 'Create step: target length in seconds. Default 120.' },
    voice: { type: 'string', description: 'Create step: narrator voice id from the text-to-speech tool (e.g. Wise_Woman, Deep_Voice_Man, Friendly_Person). Default Wise_Woman.' },
    engine: {
      type: 'string',
      enum: [...ENGINES],
      description:
        'Create step (optional): render every scene with one engine. omni-draft: fast, cheap motion preview. omni-final: full quality motion with sound. still-motion: one illustration per scene, gently panned, cheapest. Default: the style picks.',
    },
    music: { type: 'boolean', description: 'Create step: add a music bed under the narration. Default true.' },
    title: { type: 'string', description: 'Create step (optional): episode title. Defaults to the topic.' },
  },
};

interface Render {
  status: 'idle' | 'running' | 'done' | 'failed';
  url: string | null;
  error?: string;
  stale?: boolean;
}
interface SceneDto {
  id: string;
  narration: string;
  visualPrompt: string;
  engine: string;
  shotSeconds: number;
  render: Render;
}
interface EpisodeDto {
  id: string;
  title: string;
  plan: { job: { status: 'running' | 'done' | 'error'; error?: string } | null; script: unknown | null };
  narration: { status: Render['status']; audioUrl: string | null; error?: string } | null;
  scenes: SceneDto[];
  music: { status: Render['status']; url: string | null; error?: string } | null;
  musicEnabled: boolean;
  export: { status: 'idle' | 'running' | 'done' | 'failed'; url: string | null; error?: string; stale?: boolean } | null;
  savedAt: string | null;
}
interface Price {
  scenes: number;
  narration: number;
  music: number;
  total: number;
}
type EpisodeReply = { episode?: EpisodeDto; price?: Price; error?: string; creditCost?: number };

async function episodeApi(
  ctx: SkillContext,
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; data: EpisodeReply }> {
  const res = await fetch(`${ctx.baseUrl}/api/faceless-studio/episodes${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${ctx.apiKey}`,
      'Content-Type': 'application/json',
      'x-pixeldojo-source': `mcp/${ctx.mcpVersion}`,
      'x-pixeldojo-skill': 'episode',
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const data = (await res.json().catch(() => ({}))) as EpisodeReply;
  return { status: res.status, data };
}

const call = (id: string, action: 'produce' | 'status') =>
  `pixeldojo_episode with {"episode_id": "${id}", "action": "${action}"}`;
const next = (id: string, action: 'produce' | 'status', wait: string) => `Call ${call(id, action)} in ${wait}.`;

/** Same test as the web page's queue: what still has to be rendered. */
const needsRender = (s: SceneDto) =>
  s.render.status !== 'running' &&
  (s.render.status === 'idle' || s.render.status === 'failed' || Boolean(s.render.stale) || !s.render.url);

function quoteText(ep: EpisodeDto, price: Price | undefined, ctx: SkillContext): string {
  const engines = [...new Set(ep.scenes.map((s) => s.engine))].join(', ');
  const seconds = ep.scenes.reduce((n, s) => n + s.shotSeconds, 0);
  return [
    `Planned "${ep.title}" (episode_id: ${ep.id}): ${ep.scenes.length} scenes, about ${Math.round(seconds)}s of picture, engine ${engines}.`,
    ...ep.scenes.slice(0, 12).map((s, i) => `  ${i + 1}. ${s.narration.slice(0, 110)}`),
    ...(ep.scenes.length > 12 ? [`  ... and ${ep.scenes.length - 12} more.`] : []),
    '',
    price
      ? `Nothing has been charged yet. Producing it costs about ${price.total} credits at list price: scenes ${price.scenes}, narration ${price.narration}, music ${price.music}. Each part is charged as it renders; an active sale can make it lower.`
      : 'Nothing has been charged yet.',
    `Review or edit at ${ctx.baseUrl}/faceless-studio?episode=${ep.id}, or call ${call(ep.id, 'produce')} to start production.`,
  ].join('\n');
}

const PLAN_POLL_MS = 3000;
const PLAN_MAX_POLLS = 8;

/** Wait for the plan job inside one tool call (~24s, under the 30s window). */
async function waitForPlan(ctx: SkillContext, id: string): Promise<EpisodeReply | null> {
  const sleep = ctx.pollOverrides?.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  for (let i = 0; i < PLAN_MAX_POLLS; i += 1) {
    await sleep(PLAN_POLL_MS);
    const { data } = await episodeApi(ctx, 'GET', `/${id}`);
    if (data.episode?.plan.job?.status !== 'running') return data;
  }
  return null;
}

const stillPlanning = (id: string) =>
  `The script is still being written (episode_id: ${id}). Nothing has been charged. ${next(id, 'status', '~30s')}`;

async function setEngine(ctx: SkillContext, ep: EpisodeDto, engine: string): Promise<EpisodeReply> {
  const { data } = await episodeApi(ctx, 'PATCH', `/${ep.id}`, {
    scenes: ep.scenes.map((s) => ({ id: s.id, narration: s.narration, visualPrompt: s.visualPrompt, engine })),
  });
  if (!data.episode) return {};
  // The PATCH answers without a quote; the GET carries the re-priced one.
  return (await episodeApi(ctx, 'GET', `/${ep.id}`)).data;
}

async function create(input: Input, ctx: SkillContext): Promise<SkillResult> {
  if (!input.topic?.trim()) {
    return { kind: 'text', text: 'Provide a `topic` (8 to 400 characters) to create an episode.' };
  }
  const created = await episodeApi(ctx, 'POST', '', {
    topic: input.topic.trim(),
    category: input.category,
    format: input.aspect,
    targetSeconds: input.length_seconds,
    style: input.style,
    voiceId: input.voice,
    ...(input.title?.trim() ? { title: input.title.trim() } : {}),
  });
  const ep = created.data.episode;
  if (!ep) return { kind: 'text', text: `Could not create the episode: ${created.data.error ?? created.status}` };

  if (!input.music) await episodeApi(ctx, 'PATCH', `/${ep.id}`, { musicEnabled: false });

  const plan = await episodeApi(ctx, 'POST', `/${ep.id}/plan`, { scope: 'episode' });
  if (plan.status !== 202) {
    return { kind: 'text', text: `Episode created (episode_id: ${ep.id}) but planning did not start: ${plan.data.error ?? plan.status}` };
  }
  let planned = await waitForPlan(ctx, ep.id);
  if (!planned) return { kind: 'text', text: stillPlanning(ep.id) };
  if (!planned.episode || planned.episode.plan.job?.status === 'error' || planned.episode.scenes.length === 0) {
    return { kind: 'text', text: `Planning failed: ${planned.episode?.plan.job?.error ?? planned.error ?? 'no scenes came back'}` };
  }
  if (input.engine) {
    const switched = await setEngine(ctx, planned.episode, input.engine);
    if (switched.episode) planned = switched;
  }
  return { kind: 'text', text: quoteText(planned.episode!, planned.price, ctx) };
}

function progress(ep: EpisodeDto): string {
  const done = ep.scenes.filter((s) => s.render.status === 'done' && s.render.url && !s.render.stale).length;
  const running = ep.scenes.filter((s) => s.render.status === 'running').length;
  const narr = ep.narration?.audioUrl ? 'recorded' : ep.narration?.status === 'running' ? 'recording' : 'not recorded';
  const music = !ep.musicEnabled ? 'off' : ep.music?.url ? 'ready' : ep.music?.status ?? 'not started';
  const exp = ep.export?.status ?? 'not started';
  return `narration ${narr}, scenes ${done}/${ep.scenes.length}${running ? ` (${running} rendering)` : ''}, music ${music}, export ${exp}`;
}

async function status(id: string, ctx: SkillContext): Promise<SkillResult> {
  const { data, status: code } = await episodeApi(ctx, 'GET', `/${id}`);
  const ep = data.episode;
  if (!ep) return { kind: 'text', text: `Episode not found: ${data.error ?? code}` };
  if (ep.plan.job?.status === 'running') return { kind: 'text', text: stillPlanning(id) };
  if (ep.scenes.length === 0) {
    return { kind: 'text', text: `"${ep.title}" has no scene plan yet${ep.plan.job?.error ? ` (${ep.plan.job.error})` : ''}. Create a new episode with action "create".` };
  }
  if (ep.export?.status === 'done' && ep.export.url && ep.savedAt && !ep.export.stale) {
    return { kind: 'text', text: `"${ep.title}" is finished: ${ep.export.url}` };
  }
  const quote = data.price ? ` Plan quote: about ${data.price.total} credits at list price.` : '';
  return { kind: 'text', text: `"${ep.title}": ${progress(ep)}.${quote} Call ${call(id, 'produce')} to keep production moving.` };
}

/** One charged dispatch. Returns a line for the reply. */
async function generate(ctx: SkillContext, id: string, path: string, label: string, regenerate = false): Promise<{ ok: boolean; line: string }> {
  const r = await episodeApi(ctx, 'POST', `/${id}${path}`, regenerate ? { regenerate: true } : {});
  if (r.status === 200) {
    return { ok: true, line: `${label} started (${r.data.creditCost ?? '?'} credits).` };
  }
  return { ok: false, line: `${label} did not start: ${r.data.error ?? r.status}` };
}

async function produce(id: string, ctx: SkillContext): Promise<SkillResult> {
  const { data, status: code } = await episodeApi(ctx, 'GET', `/${id}`);
  const ep = data.episode;
  if (!ep) return { kind: 'text', text: `Episode not found: ${data.error ?? code}` };
  if (ep.plan.job?.status === 'running') return { kind: 'text', text: stillPlanning(id) };
  if (ep.scenes.length === 0) {
    return { kind: 'text', text: `"${ep.title}" has no scene plan to produce. Create a new episode with action "create".` };
  }

  // 1) Narration first: every scene is cut against the recorded voice, so a
  //    scene rendered before it would be re-cut and rendered twice.
  if (!ep.narration?.audioUrl) {
    if (ep.narration?.status === 'running') {
      return { kind: 'text', text: `Narration is recording. ${next(id, 'produce', '~20s')}` };
    }
    const g = await generate(ctx, id, '/narration/generate', 'Narration');
    const failed = ep.narration?.status === 'failed' ? ` (the last take failed: ${ep.narration.error ?? 'unknown'})` : '';
    return { kind: 'text', text: `${g.line}${failed} ${next(id, 'produce', '~20s')}` };
  }

  // 2) Scenes, four in flight.
  const running = ep.scenes.filter((s) => s.render.status === 'running').length;
  const queue = ep.scenes.filter(needsRender);
  if (queue.length > 0 || running > 0) {
    const lines: string[] = [];
    let spent = 0;
    for (const s of queue.slice(0, Math.max(0, MAX_IN_FLIGHT - running))) {
      const r = await episodeApi(ctx, 'POST', `/${id}/scenes/${s.id}/generate`, {});
      if (r.status === 200) spent += r.data.creditCost ?? 0;
      else {
        lines.push(`Scene ${ep.scenes.indexOf(s) + 1} did not start: ${r.data.error ?? r.status}`);
        // Out of credits or suspended: stop, the rest would fail the same way.
        if (r.status === 402 || r.status === 403) break;
      }
    }
    const failed = ep.scenes.filter((s) => s.render.status === 'failed');
    return {
      kind: 'text',
      text: [
        `In progress: ${progress(ep)}.`,
        spent > 0 ? `Started scene renders for ${Math.round(spent * 10) / 10} credits.` : '',
        failed.length > 0 ? `${failed.length} scene(s) failed and were re-queued (${failed[0]?.render.error?.slice(0, 100) ?? ''}).` : '',
        ...lines,
        next(id, 'produce', '~30s'),
      ].filter(Boolean).join('\n'),
    };
  }

  // 3) Music. A failed bed never blocks the export: it ships without one.
  if (ep.musicEnabled && !ep.music?.url && ep.music?.status !== 'failed') {
    if (ep.music?.status === 'running') {
      return { kind: 'text', text: `All scenes rendered; the music bed is composing. ${next(id, 'produce', '~20s')}` };
    }
    const g = await generate(ctx, id, '/music/generate', 'Music bed');
    return { kind: 'text', text: `All scenes rendered. ${g.line} ${next(id, 'produce', '~20s')}` };
  }

  // 4) Export, then save.
  const exp = ep.export;
  if (exp?.status === 'running') {
    return { kind: 'text', text: `Export is stitching the episode. ${next(id, 'produce', '~60s')}` };
  }
  if (exp?.status === 'done' && exp.url && !exp.stale) {
    if (ep.savedAt) return { kind: 'text', text: `"${ep.title}" is finished: ${exp.url}` };
    const saved = await episodeApi(ctx, 'POST', `/${id}/save`, {});
    const url = saved.data.episode?.export?.url;
    if (saved.status !== 200 || !url) {
      return { kind: 'text', text: `The export is ready but could not be saved: ${saved.data.error ?? saved.status}. The draft (kept 24h): ${exp.url}. ${next(id, 'produce', '~30s')}` };
    }
    return { kind: 'text', text: `"${ep.title}" is finished and saved to My Media: ${url}` };
  }
  const started = await episodeApi(ctx, 'POST', `/${id}/export`, {});
  if (started.status !== 202) {
    return { kind: 'text', text: `Export did not start: ${started.data.error ?? started.status}. ${next(id, 'produce', '~30s')}` };
  }
  const prior = exp?.status === 'failed' ? ` (the last export failed: ${exp.error ?? 'unknown'})` : '';
  const musicNote = ep.musicEnabled && ep.music?.status === 'failed' ? ' The music bed failed, so this cut has no music.' : '';
  return { kind: 'text', text: `Export started, free${prior}.${musicNote} ${next(id, 'produce', '~60s')}` };
}

async function run(input: Input, ctx: SkillContext): Promise<SkillResult> {
  const action = input.action === 'create' && input.episode_id ? 'status' : input.action;
  if (action === 'create') return create(input, ctx);
  if (!input.episode_id) return { kind: 'text', text: 'produce and status need the episode_id returned by the create step.' };
  if (action === 'produce') return produce(input.episode_id, ctx);
  return status(input.episode_id, ctx);
}

export const episodeSkill: SkillModule<Input> = {
  name: 'pixeldojo_episode',
  description:
    'Make a finished narrated faceless video (explainer, history, kids story) from one topic: script, scene visuals, AI narration, music bed, stitched export saved to My Media. Phased: create is free and returns a credit quote; produce is charged and advances one step per call (poll every ~30s until it returns the video URL); status is free.',
  inputZod: InputSchema as unknown as z.ZodType<Input>,
  inputJsonSchema: InputJsonSchema,
  allowedModels: [],
  defaultModel: '',
  run,
};
