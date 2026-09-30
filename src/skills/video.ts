/**
 * pixeldojo_video: Video Studio's Change / Move / Extend verbs for agents.
 *
 * ("Make" is pixeldojo_generate.) Every engine choice here is Video Studio's
 * own: the per-verb lists below are a hand-copy of `enginesFor(verb)` in the
 * app's lib/video-studio/engines.ts (default first, public apiIds), and each
 * payload mirrors that engine's `buildPayload` there. The package cannot
 * import app code, so tests/contracts/mcp-video-studio-parity.test.ts pins
 * both: the lists must equal the studio's, and every payload built here must
 * pass the real tool schema and use the tool's declared `media` keys.
 *
 * ponytail: payload keys are static per engine rather than resolved from
 * GET /schema at runtime. The contract test checks them against each tool's
 * declared `media` block, so drift fails CI instead of a paid job, and a
 * call costs no schema fetch.
 */
import { z } from 'zod';
import { pollJobUntilDoneOrHandoff } from '../poll.js';
import {
  type SkillContext,
  type SkillModule,
  type SkillResult,
  pollResultToSkillResult,
} from './types.js';
import { SkillUploadError, uploadLocalFile } from './upload-helpers.js';
import { PARAMS_JSON_SCHEMA, ParamsInput, applyParams, paramsWithoutModel, prefixNote } from './params.js';

export type VideoVerb = 'change' | 'move' | 'extend';

/** Mirror of enginesFor(verb).map(e => e.apiModelId ?? e.apiId). Default first. */
export const VIDEO_STUDIO_ENGINES: Record<VideoVerb, readonly string[]> = {
  change: [
    'seedance-2-5-video-edit',
    'flux-video-edit',
    'kling-video-edit',
    'wan-video-edit',
    'seedance-video-edit',
    'happyhorse-1.0-video-edit',
    'xai-video-edit',
  ],
  move: ['kling-motion-control', 'wan-video-character-swap'],
  extend: ['seedance-2-5-video-edit', 'wan-2.7-i2v', 'grok-video-extend'],
};

const VERBS = ['change', 'move', 'extend'] as const;

/** Only one extend engine can run a clip backwards (engines.ts `directions`). */
const BACKWARD_ENGINES = new Set(['seedance-2-5-video-edit']);

export interface VideoPayloadInput {
  prompt?: string;
  videoUrl: string;
  images: string[];
  /** Source clip length in seconds. */
  videoDuration?: number;
  duration?: number;
  direction?: 'forward' | 'backward';
}

type Built = { body: { prompt: string; [key: string]: unknown }; note?: string } | { error: string };

const clamp = (n: number, min: number, max: number) => Math.min(max, Math.max(min, Math.round(n)));

/** Engines whose schema requires the source length (their credit meter). */
const NEEDS_VIDEO_DURATION = new Set([
  'flux-video-edit',
  'kling-video-edit',
  'wan-video-edit',
  'seedance-video-edit',
  'happyhorse-1.0-video-edit',
  'xai-video-edit',
  'kling-motion-control',
  'wan-video-character-swap',
]);

/** Change engines with no reference-image slot. */
const NO_IMAGE_ENGINES = new Set(['flux-video-edit', 'xai-video-edit']);

/** Each engine's payload, mirroring buildPayload in lib/video-studio/engines.ts. */
export function buildVideoPayload(verb: VideoVerb, apiId: string, i: VideoPayloadInput): Built {
  const prompt = i.prompt ?? '';
  const vd = i.videoDuration;
  if (NEEDS_VIDEO_DURATION.has(apiId) && vd === undefined) {
    return {
      error: `${apiId} needs video_duration: the source clip's length in seconds (it sets the credit cost).`,
    };
  }
  if (verb === 'move' && !i.images[0]) {
    return { error: `The move verb needs image_url: the character image to put into the video.` };
  }
  const droppedImages =
    i.images.length > 0 && (verb === 'extend' || NO_IMAGE_ENGINES.has(apiId))
      ? `${apiId} takes no reference images, so I left them off.`
      : undefined;

  if (verb === 'change') {
    switch (apiId) {
      case 'seedance-2-5-video-edit':
        return {
          body: {
            mode: 'edit',
            prompt,
            video_url: i.videoUrl,
            reference_images: i.images,
            ...(vd !== undefined ? { source_duration_seconds: vd } : {}),
          },
        };
      case 'flux-video-edit':
        // Schema is .int(); a probed 7.4s float is rejected.
        return { body: { prompt, video: i.videoUrl, video_duration: Math.ceil(vd!) }, note: droppedImages };
      case 'xai-video-edit':
        return { body: { prompt, video_url: i.videoUrl, video_duration: vd }, note: droppedImages };
      case 'happyhorse-1.0-video-edit':
        return { body: { prompt, video_url: i.videoUrl, video_duration: vd, reference_urls: i.images } };
      default: // kling-video-edit, wan-video-edit, seedance-video-edit
        return { body: { prompt, video_url: i.videoUrl, video_duration: vd, image_urls: i.images } };
    }
  }

  if (verb === 'move') {
    if (apiId === 'wan-video-character-swap') {
      // No prompt field on this tool; the SDK needs the key and the schema strips it.
      return { body: { prompt: '', image_url: i.images[0], video_url: i.videoUrl, video_duration: vd } };
    }
    return {
      body: {
        prompt,
        video: i.videoUrl,
        video_duration: vd,
        character_image: i.images[0],
        // Not a background toggle: 'video' is the 30s duration cap.
        character_orientation: 'video',
      },
    };
  }

  // extend
  switch (apiId) {
    case 'seedance-2-5-video-edit':
      return {
        body: {
          mode: 'extend',
          prompt,
          video_url: i.videoUrl,
          direction: i.direction ?? 'forward',
          duration: clamp(i.duration ?? 5, 4, 30),
          ...(vd !== undefined ? { source_duration_seconds: vd } : {}),
        },
        note: droppedImages,
      };
    case 'wan-2.7-i2v': {
      const chosen = clamp(i.duration ?? 5, 2, 15);
      return {
        body: {
          mode: 'video-extend',
          prompt,
          video_url: i.videoUrl,
          // A continuation shorter than its own source is rejected outright.
          duration: vd ? Math.min(15, Math.max(chosen, Math.ceil(vd) + 1)) : chosen,
          ...(vd ? { source_video_duration: vd } : {}),
        },
        note: droppedImages,
      };
    }
    default: // grok-video-extend: duration is the seconds ADDED; the server measures the source.
      return {
        body: { prompt, video_url: i.videoUrl, extension_duration: clamp(i.duration ?? 6, 2, 10) },
        note: droppedImages,
      };
  }
}

const InputSchema = z.object({
  verb: z.enum(VERBS),
  prompt: z.string().max(8000).optional(),
  video_url: z.string().url().optional(),
  video_path: z.string().min(1).optional(),
  image_url: z.string().url().optional(),
  image_urls: z.array(z.string().url()).optional(),
  image_path: z.string().min(1).optional(),
  model: z.string().optional(),
  video_duration: z.number().positive().optional(),
  duration: z.number().int().positive().optional(),
  direction: z.enum(['forward', 'backward']).optional(),
  params: ParamsInput,
});

type Input = z.infer<typeof InputSchema>;

const engineList = (verb: VideoVerb) =>
  `${verb}: ${VIDEO_STUDIO_ENGINES[verb].join(', ')} (default ${VIDEO_STUDIO_ENGINES[verb][0]})`;

const InputJsonSchema = {
  type: 'object',
  properties: {
    verb: {
      type: 'string',
      enum: VERBS,
      description:
        'change = restyle or edit an existing clip; move = put a character image into a driving video (motion transfer / character swap); extend = continue a clip forward (or backward on the default engine).',
    },
    prompt: {
      type: 'string',
      description:
        'What to change, how the character should move, or what happens next. Required for change and extend. Optional for move (wan-video-character-swap ignores it).',
    },
    video_url: {
      type: 'string',
      format: 'uri',
      description: 'The source clip (change, extend) or the driving motion clip (move). Required.',
    },
    video_path: {
      type: 'string',
      description: 'Absolute local path to the source clip (MP4, WebM, MOV). Uploaded to 24h temp storage and used as video_url.',
    },
    image_url: {
      type: 'string',
      format: 'uri',
      description: 'The character image (move, required) or a reference image (change, optional; some engines take none).',
    },
    image_urls: {
      type: 'array',
      items: { type: 'string', format: 'uri' },
      description: 'More reference images for change engines that take a set. Move uses the first image only.',
    },
    image_path: {
      type: 'string',
      description: 'Absolute local path to the character or reference image. Uploaded to 24h temp storage and used as image_url.',
    },
    model: {
      type: 'string',
      description: `Video Studio engine for this verb. Omit for the default. ${VERBS.map((v) => engineList(v)).join('; ')}. A model not on the verb's list is replaced by the default and the result says so.`,
    },
    video_duration: {
      type: 'number',
      description:
        "The source clip's length in seconds. Required by every engine except the change/extend default and grok-video-extend, since it sets their credit cost.",
    },
    duration: {
      type: 'integer',
      description:
        'Extend only: output length in seconds (default engine 4-30, wan-2.7-i2v 2-15 total), or seconds added on grok-video-extend (2-10). Ignored by change and move, which keep the source length.',
    },
    direction: {
      type: 'string',
      enum: ['forward', 'backward'],
      description: 'Extend only. backward adds footage before the clip; only the default engine supports it.',
    },
    params: PARAMS_JSON_SCHEMA,
  },
  required: ['verb'],
} as const;

async function run(input: Input, ctx: SkillContext): Promise<SkillResult> {
  const paramsGate = paramsWithoutModel(input.params, input.model);
  if (paramsGate) return { kind: 'text', text: paramsGate };

  const verb = input.verb;
  const engines = VIDEO_STUDIO_ENGINES[verb];
  const notes: string[] = [];

  // Substitute, never dead-end: a model that is not one of this verb's
  // Video Studio engines runs on the verb default instead.
  let apiId = input.model ?? engines[0];
  if (!engines.includes(apiId)) {
    notes.push(`${apiId} is not a Video Studio ${verb} engine, so I used ${engines[0]} instead.`);
    apiId = engines[0];
  }
  if (verb === 'extend' && input.direction === 'backward' && !BACKWARD_ENGINES.has(apiId)) {
    notes.push(`${apiId} only extends forward, so I used ${engines[0]} to extend backward.`);
    apiId = engines[0];
  }

  let videoUrl = input.video_url;
  const images = [...(input.image_url ? [input.image_url] : []), ...(input.image_urls ?? [])];
  try {
    if (!videoUrl && input.video_path) videoUrl = await uploadLocalFile(input.video_path, ctx);
    if (!input.image_url && input.image_path) images.unshift(await uploadLocalFile(input.image_path, ctx));
  } catch (err) {
    if (err instanceof SkillUploadError) {
      return { kind: 'text', text: `pixeldojo_video (upload): ${err.userMessage}` };
    }
    throw err;
  }

  if (!videoUrl) {
    return {
      kind: 'text',
      text: `pixeldojo_video ${verb} needs video_url: the ${verb === 'move' ? 'driving motion clip' : 'source clip'}.`,
    };
  }
  if (verb !== 'move' && !input.prompt?.trim()) {
    return { kind: 'text', text: `pixeldojo_video ${verb} needs a prompt.` };
  }

  const built = buildVideoPayload(verb, apiId, {
    prompt: input.prompt,
    videoUrl,
    images: images.filter((u, i, all) => all.indexOf(u) === i),
    videoDuration: input.video_duration,
    duration: input.duration,
    direction: input.direction,
  });
  if ('error' in built) return { kind: 'text', text: `pixeldojo_video: ${built.error}` };
  if (built.note) notes.push(built.note);

  const body = built.body;
  const paramsNote = applyParams(body, input.params, input.model, apiId);
  if (paramsNote) notes.push(paramsNote);

  const submitted = await ctx.client.run(apiId, body);
  const result = await pollJobUntilDoneOrHandoff(
    submitted.jobId,
    (id) => ctx.client.getJob(id),
    ctx.buildStatusUrl,
    { now: ctx.pollOverrides?.now, sleep: ctx.pollOverrides?.sleep },
  );

  return prefixNote(
    pollResultToSkillResult(result, (urls) =>
      urls.length === 0
        ? `Job ${submitted.jobId} completed but returned no assets.`
        : `Video ready (${verb} on ${apiId}). Asset: ${urls.join(', ')}`,
    ),
    notes.join(' '),
  );
}

const BASE_DESCRIPTION =
  "Video Studio verbs for an existing clip, on the same engines the studio uses. verb=change restyles or edits a clip (prompt + video_url, optional reference images). verb=move puts a character image into a driving video's motion (video_url + image_url + video_duration). verb=extend continues a clip forward, or backward on the default engine (prompt + video_url, optional duration and direction). Omit `model` for the studio default; engine-specific settings go in `params` with an explicit `model`. To make a new video, use pixeldojo_generate. Returns asset URLs, or a jobId for pixeldojo_status when the job outlasts the 30s wait.";

export const videoSkill: SkillModule<Input> = {
  name: 'pixeldojo_video',
  description: `${BASE_DESCRIPTION} Local files: video_path / image_path (uploaded to 24h temp storage first).`,
  hostedDescription: `${BASE_DESCRIPTION} Media must be public http(s) URLs.`,
  inputZod: InputSchema,
  inputJsonSchema: InputJsonSchema,
  allowedModels: Array.from(new Set(VERBS.flatMap((v) => VIDEO_STUDIO_ENGINES[v]))),
  defaultModel: VIDEO_STUDIO_ENGINES.change[0],
  run,
};
