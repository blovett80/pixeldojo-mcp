/**
 * pixeldojo_character — consistent characters across shots.
 *
 * The whitelist MIRRORS `AGENT_CHARACTER_MODELS` in the app's
 * lib/agent/roster.ts — Character Studio's roster, which is the list that was
 * actually verified for likeness retention. This package publishes to npm
 * standalone and cannot import from the app, so the array below is a copy;
 * the app's tests/contracts/mcp-character-roster-parity.test.ts fails if the
 * two drift. That drift is not hypothetical: flux-edit and gpt-image-2-edit
 * sat here for months after the agent dropped them ("never identity models"),
 * so MCP callers were routed to models that cannot lock a face.
 *
 * ideogram-character is deliberately NOT offered: its tool schema requires
 * a field named `character_reference_image` (singular) that none of this
 * skill's request shapes produce, so every call to it failed with
 * "character_reference_image: Required" — confirmed via a live test sweep
 * 2026-07-08, never caught before because nothing exercised the reference-
 * image path end-to-end.
 */
import { z } from 'zod';
import { pollJobUntilDoneOrHandoff } from '../poll.js';
import {
  type SkillContext,
  type SkillModule,
  type SkillResult,
  pollResultToSkillResult,
} from './types.js';
import { isAudioUrl, isVideoUrl, resolveImageRefs, snapAspectRatio } from './schema-snap.js';
import {
  PARAMS_JSON_SCHEMA,
  ParamsInput,
  applyParams,
  paramsWithoutModel,
  prefixNote,
} from './params.js';

const ALLOWED = [
  'seedream-5',
  'seedream-4',
  'seedream-5-flash',
  'google-nano-banana',
  'wan-2.7-image-edit',
  'qwen-3-pro',
  'qwen-image-2.0-pro',
] as const;
type AllowedModel = (typeof ALLOWED)[number];
const DEFAULT_MODEL: AllowedModel = 'seedream-5';

/** The agent's own cap on reference images. More angles of the same person
 *  lock a face far better than one photo; models with a smaller schema cap
 *  get clamped to it by resolveImageRefs, which reads maxItems. */
const MAX_REFERENCES = 9;

// wan-2.7-image-edit is an edit model — its schema requires image_urls
// (min 1), unlike the rest of the roster which can generate from a prompt
// alone. Without this gate the request reaches the backend and is rejected
// downstream ("image_urls: Array must contain at least 1 element(s)"), which
// loops agents that retry without realizing the input was the issue.
const REQUIRES_REFERENCE = new Set<AllowedModel>(['wan-2.7-image-edit']);

/** OFFLINE FALLBACK ONLY — where each roster model keys its references when
 *  GET /schema is unreachable. Copied from each tool.config's `media.image`
 *  declaration, which is what resolveImageRefs returns when it CAN reach the
 *  endpoint. All are array fields. */
const FALLBACK_REF_KEY: Record<AllowedModel, string> = {
  'seedream-5': 'image_urls',
  'seedream-4': 'image_urls',
  'seedream-5-flash': 'image_urls',
  'google-nano-banana': 'image_input',
  'wan-2.7-image-edit': 'image_urls',
  'qwen-3-pro': 'image',
  'qwen-image-2.0-pro': 'reference_images',
};

const InputSchema = z.object({
  prompt: z.string().min(1).max(8000),
  model: z
    .string()
    .optional()
    .describe(`One of: ${ALLOWED.join(', ')}. Defaults to ${DEFAULT_MODEL}.`),
  reference_image_url: z
    .string()
    .url()
    .optional()
    .describe(
      'Single reference image of the character. Prefer reference_image_urls — more angles lock the face better.',
    ),
  reference_image_urls: z
    .array(z.string().url())
    .min(1)
    .max(MAX_REFERENCES)
    .optional()
    .describe(
      `All references for this shot (1-${MAX_REFERENCES}), most important first. Multiple angles of the same person lock the face far better than one photo. Models that take fewer are clamped to their own cap.`,
    ),
  aspect_ratio: z.string().optional().describe('Honored where the model declares the field.'),
  params: ParamsInput,
});

type Input = z.infer<typeof InputSchema>;

const InputJsonSchema = {
  type: 'object',
  properties: {
    prompt: { type: 'string', description: 'The shot to render: scene, pose, wardrobe, framing. The references supply the identity.' },
    model: {
      type: 'string',
      enum: ALLOWED,
      description: `One of: ${ALLOWED.join(', ')}. Defaults to ${DEFAULT_MODEL}.`,
    },
    reference_image_url: {
      type: 'string',
      format: 'uri',
      description:
        'Single still of the character. Ignored when reference_image_urls is set; prefer that, since more angles lock the face better.',
    },
    reference_image_urls: {
      type: 'array',
      items: { type: 'string', format: 'uri' },
      minItems: 1,
      maxItems: MAX_REFERENCES,
      description:
        'All reference stills for this shot (1-9), most important first. Multiple angles of the same person lock the face far better than one photo. Models that take fewer keep the first ones and the result says how many were dropped. Required for wan-2.7-image-edit; clips and audio are refused.',
    },
    aspect_ratio: {
      type: 'string',
      description:
        'e.g. "1:1", "16:9", "9:16". Snapped to the nearest ratio the model supports, and dropped for models with no aspect_ratio field (including the default seedream-5, which sizes by image_size: set that in params with an explicit model).',
    },
    params: PARAMS_JSON_SCHEMA,
  },
  required: ['prompt'],
} as const;

async function run(input: Input, ctx: SkillContext): Promise<SkillResult> {
  const paramsGate = paramsWithoutModel(input.params, input.model);
  if (paramsGate) return { kind: 'text', text: paramsGate };

  const requested = (input.model ?? DEFAULT_MODEL) as string;
  if (!(ALLOWED as readonly string[]).includes(requested)) {
    return {
      kind: 'text',
      text:
        `Unknown model "${requested}" for pixeldojo_character. ` +
        `Allowed: ${ALLOWED.join(', ')}.`,
    };
  }
  const apiId = requested as AllowedModel;

  const refUrls = (
    input.reference_image_urls && input.reference_image_urls.length > 0
      ? input.reference_image_urls
      : input.reference_image_url
        ? [input.reference_image_url]
        : []
  ).filter((u, i, all) => all.indexOf(u) === i);

  // Identity work is still-image work. A clip or a track handed to any model
  // on this roster dies at the PROVIDER ("does not point to a valid image …
  // content-type: video/mp4"), after the credit deduction, and its rejection
  // tells the caller nothing about where that file could have gone.
  const wrongKind = refUrls.find((u) => isVideoUrl(u) || isAudioUrl(u));
  if (wrongKind) {
    return {
      kind: 'text',
      text:
        `pixeldojo_character works on still images, and ${wrongKind} is not one. ` +
        `Use pixeldojo_generate or pixeldojo_storyboard with video_url to work from a clip ` +
        `(or image_url for an audio track — they route to the reference engine). ` +
        `For this treatment, give me a still frame.`,
    };
  }

  if (REQUIRES_REFERENCE.has(apiId) && refUrls.length === 0) {
    return {
      kind: 'text',
      text:
        `pixeldojo_character with model="${apiId}" requires a reference image ` +
        `(reference_image_url / reference_image_urls — the source image of the character to edit). ` +
        `For generation from a prompt alone, use model="${DEFAULT_MODEL}".`,
    };
  }

  const body: { prompt: string; [key: string]: unknown } = { prompt: input.prompt };
  let dropped = 0;
  if (refUrls.length > 0) {
    // Where the references go comes from the model's DECLARED media slot,
    // falling back to its published schema, falling back to the static map.
    // The old hardcoded per-model switch is what let flux-edit receive
    // `input_image` when its schema wants `input_image_1` — a wrong key is
    // silently stripped, so the user is billed for an image built from
    // nothing.
    const refs = await resolveImageRefs(apiId, refUrls, ctx.client);
    if (refs) {
      body[refs.key] = refs.value;
      if (refs.also) Object.assign(body, refs.also);
      dropped = refs.dropped;
    } else {
      body[FALLBACK_REF_KEY[apiId]] = refUrls;
    }
  }
  // seedream-5/seedream-4 key sizing on `image_size` instead of aspect_ratio
  // — snapAspectRatio confirms this from each model's real schema and omits
  // the field entirely for them, rather than relying on a hardcoded per-model
  // allowlist that can go stale. onUnknown 'omit': when the schema fetch
  // fails we must NOT forward aspect_ratio to models whose schemas never
  // declared it.
  const snappedAspect = await snapAspectRatio(apiId, input.aspect_ratio, ctx.client, {
    onUnknown: 'omit',
  });
  if (snappedAspect !== undefined) body.aspect_ratio = snappedAspect;

  const note = [
    dropped > 0
      ? `${dropped} reference${dropped === 1 ? '' : 's'} dropped — ${apiId} accepts fewer.`
      : undefined,
    applyParams(body, input.params, input.model, apiId),
  ]
    .filter(Boolean)
    .join(' ');

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
        : `Character shot ready. Asset: ${urls[0]}`,
    ),
    note,
  );
}

export const characterSkill: SkillModule<Input> = {
  name: 'pixeldojo_character',
  description:
    'Generate or edit consistent characters across shots. Pass reference_image_urls (up to 9) to lock identity — send every photo of the person you have, since more angles hold the face far better than one. Defaults to seedream-5.',
  inputZod: InputSchema,
  inputJsonSchema: InputJsonSchema,
  allowedModels: [...ALLOWED],
  defaultModel: DEFAULT_MODEL,
  run,
};
