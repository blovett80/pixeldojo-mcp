/**
 * pixeldojo_storyboard — multi-shot scenes from one brief.
 *
 * v1 implementation: dispatches a single video generation as the storyboard
 * "preview" frame. Full multi-shot orchestration (4+ shots stitched together)
 * is a future enhancement that needs LLM-driven shot decomposition; for now
 * the skill ships as a single-call surface so LLMs can issue it without
 * waiting on that pipeline.
 *
 * Whitelisted models: veo-3.1-fast (default), veo-3.1-standard,
 * kling-video-v3-standard-text, seedance-2-high, seedance-2-reference
 * (the reference engine — see run()).
 *
 * Reference flows (image_url / video_url) delegate to pixeldojo_generate
 * rather than duplicating its media routing; the allowlist and the brief
 * still belong to this skill.
 */
import { z } from 'zod';
import { pollJobUntilDoneOrHandoff } from '../poll.js';
import {
  type SkillContext,
  type SkillModule,
  type SkillResult,
  pollResultToSkillResult,
} from './types.js';
import { snapAspectRatio, snapDuration } from './schema-snap.js';
import { VIDEO_REFERENCE_MODEL, generateSkill } from './generate.js';
import {
  PARAMS_JSON_SCHEMA,
  ParamsInput,
  applyParams,
  paramsWithoutModel,
  prefixNote,
} from './params.js';

// Bare family ids ('veo-3.1', 'kling-video', 'seedance-2') are grouping
// constructs only — none is itself a runnable public apiId (all three
// 404'd with "Model '<id>' not found", confirmed via a live test sweep
// 2026-07-08). Real variants:
//   - veo-3.1-fast/-standard/-lite — -lite excluded (drops reference-image,
//     audio, 1:1-aspect support an agent caller may reasonably assume).
//   - kling-video splits into separate -text/-image apiIds (a `mode` field
//     baked into each variant's inputDefaults, not a runtime choice on one
//     shared id) — this v1 skill has no image input yet, so -text.
//   - seedance-2 splits into -high (general/default) and -reference
//     (dedicated image-conditioned variant) — same reasoning, -high.
// Both -text/-high were live-tested end to end 2026-07-08: dispatched,
// handed off past the 30s sync window, and completed with a real asset.
//   - seedance-2-reference is the reference engine: the only entry here that
//     reads a still, a clip OR an audio track, so every reference-bearing
//     storyboard with no model named goes to it (see run()).
const ALLOWED = [
  'veo-3.1-fast',
  'veo-3.1-standard',
  'kling-video-v3-standard-text',
  'seedance-2-high',
  VIDEO_REFERENCE_MODEL,
] as const;
type AllowedModel = (typeof ALLOWED)[number];
const DEFAULT_MODEL: AllowedModel = 'veo-3.1-fast';

const InputSchema = z.object({
  brief: z.string().min(1).max(8000).describe('Storyboard brief: scene, shots, mood, action.'),
  model: z
    .string()
    .optional()
    .describe(`One of: ${ALLOWED.join(', ')}. Defaults to ${DEFAULT_MODEL}.`),
  aspect_ratio: z.string().optional(),
  duration: z.number().int().positive().optional(),
  image_url: z
    .string()
    .url()
    .optional()
    .describe('Reference still to build the shot from (character, product, location).'),
  video_url: z
    .string()
    .url()
    .optional()
    .describe('Source clip to work from. Use this for videos; image_url is for still frames.'),
  params: ParamsInput,
});

type Input = z.infer<typeof InputSchema>;

const InputJsonSchema = {
  type: 'object',
  properties: {
    brief: {
      type: 'string',
      description: 'Scene brief: setting, action, camera, mood. Sent to the video model as its prompt.',
    },
    model: {
      type: 'string',
      enum: ALLOWED,
      description: `One of: ${ALLOWED.join(', ')}. Defaults to ${DEFAULT_MODEL}, or ${VIDEO_REFERENCE_MODEL} when image_url or video_url is given.`,
    },
    aspect_ratio: {
      type: 'string',
      description:
        'e.g. "16:9", "9:16", "1:1". Snapped to the nearest ratio the model supports, and dropped if the model has no aspect_ratio field.',
    },
    duration: {
      type: 'integer',
      description: 'Clip length in seconds. Snapped or clamped to what the model allows.',
    },
    image_url: {
      type: 'string',
      format: 'uri',
      description:
        'Reference still to build the shot from (character, product, location). A clip or audio URL here is detected by extension and routed as that kind of media.',
    },
    video_url: {
      type: 'string',
      format: 'uri',
      description:
        'Source clip to work from. Use this for videos; image_url is for stills. A named model with no clip input is swapped for seedance-2-reference and the result says so.',
    },
    params: PARAMS_JSON_SCHEMA,
  },
  required: ['brief'],
} as const;

async function run(input: Input, ctx: SkillContext): Promise<SkillResult> {
  const paramsGate = paramsWithoutModel(input.params, input.model);
  if (paramsGate) return { kind: 'text', text: paramsGate };

  const requested = (input.model ?? DEFAULT_MODEL) as string;
  if (!(ALLOWED as readonly string[]).includes(requested)) {
    return {
      kind: 'text',
      text:
        `Unknown model "${requested}" for pixeldojo_storyboard. ` +
        `Allowed: ${ALLOWED.join(', ')}.`,
    };
  }

  // A reference-bearing storyboard is exactly what pixeldojo_generate already
  // does: media-kind detection, declared media slots, the clip-engine
  // substitution note, and the params overlay. Delegate instead of growing a
  // second copy of that here — this skill's own job is the brief and the
  // video-model allowlist, both of which still apply above.
  //
  // The unnamed-model default flips to the reference engine rather than
  // generate's text-to-image default: a storyboard shot is a video, and the
  // reference engine is the one entry that reads a still, a clip or a track.
  // Params can't leak onto it unasked — the gate above refuses them without
  // an explicit model.
  if (input.image_url || input.video_url) {
    return generateSkill.run(
      {
        prompt: input.brief,
        model: input.model ?? VIDEO_REFERENCE_MODEL,
        image_url: input.image_url,
        video_url: input.video_url,
        aspect_ratio: input.aspect_ratio,
        duration: input.duration,
        params: input.params,
      },
      ctx,
    );
  }

  const apiId = requested as AllowedModel;

  const [snappedAspect, snappedDuration] = await Promise.all([
    snapAspectRatio(apiId, input.aspect_ratio, ctx.client),
    snapDuration(apiId, input.duration, ctx.client),
  ]);
  const body: { prompt: string; [key: string]: unknown } = { prompt: input.brief };
  if (snappedAspect !== undefined) body.aspect_ratio = snappedAspect;
  if (snappedDuration !== undefined) body.duration = snappedDuration;
  const note = applyParams(body, input.params, input.model, apiId);

  const submitted = await ctx.client.run(apiId, body);

  const result = await pollJobUntilDoneOrHandoff(
    submitted.jobId,
    (id) => ctx.client.getJob(id),
    ctx.buildStatusUrl,
    {
      now: ctx.pollOverrides?.now,
      sleep: ctx.pollOverrides?.sleep,
    },
  );

  return prefixNote(
    pollResultToSkillResult(result, (urls) =>
      urls.length === 0
        ? `Job ${submitted.jobId} completed but returned no assets.`
        : `Storyboard preview ready. Asset: ${urls[0]}`,
    ),
    note,
  );
}

export const storyboardSkill: SkillModule<Input> = {
  name: 'pixeldojo_storyboard',
  description:
    'Generate one short video clip (a single shot, not a multi-panel storyboard) from a scene brief. A text-only brief runs on veo-3.1-fast unless `model` names another allowed video model. With image_url (reference still) or video_url (source clip) and no `model`, it runs on seedance-2-reference, with the same reference routing as pixeldojo_generate. For a multi-shot film with dialogue and a soundtrack, use pixeldojo_film.',
  inputZod: InputSchema,
  inputJsonSchema: InputJsonSchema,
  allowedModels: [...ALLOWED],
  defaultModel: DEFAULT_MODEL,
  run,
};
