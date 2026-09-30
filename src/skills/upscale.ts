/**
 * pixeldojo_upscale — enhance any image or video.
 *
 * Whitelisted models: magnific-upscaler (default), creative-upscale,
 * face-enhance, video-upscaler. The image models key the source on `image`
 * (NOT `image_url` — every one of those tool schemas uses `image`; sending
 * `image_url` previously 400'd with "image: Required" on every call,
 * confirmed via a live test sweep 2026-07-08). scale_factor also differs by
 * model: magnific wants a string enum ('2x'|'4x'|'8x'|'16x'), the others a
 * plain number — this skill takes a plain number from the caller and
 * converts per model. video-upscaler (FlashVSR) keys the clip on `video`
 * and requires `video_duration` (its credit meter); a clip auto-routes to
 * it when no model is named.
 */
import { z } from 'zod';
import { pollJobUntilDoneOrHandoff } from '../poll.js';
import {
  type SkillContext,
  type SkillModule,
  type SkillResult,
  pollResultToSkillResult,
} from './types.js';
import { isVideoUrl } from './schema-snap.js';

const ALLOWED = ['magnific-upscaler', 'creative-upscale', 'face-enhance', 'video-upscaler'] as const;
type AllowedModel = (typeof ALLOWED)[number];
const DEFAULT_MODEL: AllowedModel = 'magnific-upscaler';
const VIDEO_MODEL: AllowedModel = 'video-upscaler';

const VIDEO_RESOLUTIONS = ['720p', '1080p', '2k', '4k'] as const;

const InputSchema = z.object({
  image_url: z.string().url().optional().describe('URL of the source image to upscale.'),
  video_url: z
    .string()
    .url()
    .optional()
    .describe('URL of a source video clip — routes to video-upscaler. MP4 only, max 500 MB.'),
  model: z
    .string()
    .optional()
    .describe(`One of: ${ALLOWED.join(', ')}. Defaults to ${DEFAULT_MODEL} (a clip defaults to ${VIDEO_MODEL}).`),
  scale_factor: z
    .number()
    .min(1)
    .max(16)
    .optional()
    .describe(
      'Image models only. Magnific snaps to the nearest of 2/4/8/16 (default 2); creative-upscale accepts 1-10 (default 2); face-enhance accepts 1-8 (default 4).',
    ),
  creativity: z
    .number()
    .int()
    .min(-10)
    .max(10)
    .optional()
    .describe('Magnific only: integer -10 (preserve) → 10 (creative). Defaults to 0.'),
  video_duration: z
    .number()
    .positive()
    .optional()
    .describe('video-upscaler only, REQUIRED there: source clip length in seconds (its credit meter).'),
  target_resolution: z
    .enum(VIDEO_RESOLUTIONS)
    .optional()
    .describe('video-upscaler only: target output resolution. Defaults to 1080p.'),
});

type Input = z.infer<typeof InputSchema>;

const InputJsonSchema = {
  type: 'object',
  properties: {
    image_url: {
      type: 'string',
      format: 'uri',
      description: 'Source image to upscale (image models). A clip URL here (.mp4/.mov/.webm) is treated as video_url.',
    },
    video_url: {
      type: 'string',
      format: 'uri',
      description: 'Source video clip (MP4, max 500 MB). Routes to video-upscaler when no model is named; needs video_duration.',
    },
    model: {
      type: 'string',
      enum: ALLOWED,
      description: `Defaults to ${DEFAULT_MODEL}, or ${VIDEO_MODEL} when the source is a clip. face-enhance is for portraits.`,
    },
    scale_factor: {
      type: 'number',
      minimum: 1,
      maximum: 16,
      description:
        'Image models only. magnific-upscaler snaps to the nearest of 2/4/8/16 (default 2); creative-upscale clamps to 1-10 (default 2); face-enhance clamps to 1-8 (default 4).',
    },
    creativity: {
      type: 'integer',
      minimum: -10,
      maximum: 10,
      description: 'magnific-upscaler only: sent unchanged as its creativity setting, an integer from -10 to 10 (default 0; lower preserves the source, higher invents more detail).',
    },
    video_duration: {
      type: 'number',
      description: 'video-upscaler only, required there: source clip length in seconds. It sets the cost (1 credit per second).',
    },
    target_resolution: {
      type: 'string',
      enum: VIDEO_RESOLUTIONS,
      description: 'video-upscaler only: output resolution. Defaults to 1080p.',
    },
  },
} as const;

async function run(input: Input, ctx: SkillContext): Promise<SkillResult> {
  // A clip in either slot (video_url, or an mp4 pasted into image_url — the
  // habit of most LLMs) means the video upscaler; no model named routes there
  // automatically rather than sending an mp4 to an image engine.
  const clipUrl =
    input.video_url ?? (input.image_url && isVideoUrl(input.image_url) ? input.image_url : undefined);
  const requested = (input.model ?? (clipUrl ? VIDEO_MODEL : DEFAULT_MODEL)) as string;
  if (!(ALLOWED as readonly string[]).includes(requested)) {
    return {
      kind: 'text',
      text: `Unknown model "${requested}" for pixeldojo_upscale. Allowed: ${ALLOWED.join(', ')}.`,
    };
  }
  const apiId = requested as AllowedModel;

  if (apiId === VIDEO_MODEL) {
    if (!clipUrl) {
      return {
        kind: 'text',
        text: 'pixeldojo_upscale with model="video-upscaler" requires video_url (the source clip).',
      };
    }
    if (input.video_duration === undefined) {
      return {
        kind: 'text',
        text:
          'pixeldojo_upscale with model="video-upscaler" requires video_duration ' +
          '(source clip length in seconds — it sets the credit cost, 1 credit/second).',
      };
    }
  } else if (!input.image_url || input.image_url === clipUrl) {
    // Second clause: an explicitly-named image model whose only source is a
    // clip. Dispatching the mp4 dies at the provider AFTER the credit
    // deduction, so refuse with the correction instead.
    return {
      kind: 'text',
      text: input.image_url
        ? `${apiId} upscales still images, but the source is a video clip. Use model="video-upscaler" with video_url and video_duration (seconds).`
        : `pixeldojo_upscale with model="${apiId}" requires image_url (the source image).`,
    };
  }

  // Upscalers have no `prompt` field but the SDK's RunOptions requires one;
  // pass an empty string. Zod strips unrecognized keys by default (no
  // .passthrough() on any tool schema), so the extra field is silently
  // dropped for models that don't declare it.
  const body: { prompt: string; [key: string]: unknown } = {
    prompt: '',
    ...(apiId === VIDEO_MODEL ? { video: clipUrl } : { image: input.image_url }),
  };
  if (apiId === VIDEO_MODEL) {
    body.video_duration = input.video_duration;
    if (input.target_resolution) body.target_resolution = input.target_resolution;
  } else if (apiId === 'magnific-upscaler') {
    const allowed = [2, 4, 8, 16];
    const requestedScale = input.scale_factor ?? 2;
    const nearest = allowed.reduce((a, b) =>
      Math.abs(b - requestedScale) < Math.abs(a - requestedScale) ? b : a,
    );
    body.scale_factor = `${nearest}x`;
    if (input.creativity !== undefined) body.creativity = input.creativity;
  } else if (apiId === 'creative-upscale') {
    body.scale_factor = Math.min(10, Math.max(1, input.scale_factor ?? 2));
  } else if (apiId === 'face-enhance') {
    body.scale_factor = Math.min(8, Math.max(1, input.scale_factor ?? 4));
  }

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

  return pollResultToSkillResult(result, (urls) =>
    urls.length === 0
      ? `Job ${submitted.jobId} completed but returned no assets.`
      : `Upscaled. Asset: ${urls[0]}`,
  );
}

export const upscaleSkill: SkillModule<Input> = {
  name: 'pixeldojo_upscale',
  description:
    'Enhance an image or video. Magnific (default) supports configurable scale_factor and creativity; face-enhance for portraits; video-upscaler (FlashVSR, up to 4K) for clips — pass video_url plus video_duration in seconds.',
  inputZod: InputSchema,
  inputJsonSchema: InputJsonSchema,
  allowedModels: [...ALLOWED],
  defaultModel: DEFAULT_MODEL,
  run,
};
