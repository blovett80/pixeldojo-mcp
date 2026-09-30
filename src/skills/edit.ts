/**
 * pixeldojo_edit — instruction-based image editing.
 *
 * Default routing: wan-2.7-image-edit (top Canvas edit model). Users can
 * override `model` from the edit-capable whitelist. Each model has slightly
 * different payload shape (image_urls vs image vs images, size vs
 * aspect_ratio), so the skill normalizes the user-facing input into the
 * model-specific body via a small adapter map.
 */
import { z } from 'zod';
import { pollJobUntilDoneOrHandoff } from '../poll.js';
import {
  type SkillContext,
  type SkillModule,
  type SkillResult,
  pollResultToSkillResult,
} from './types.js';
import {
  SkillUploadError,
  uploadLocalFile,
  uploadLocalFiles,
} from './upload-helpers.js';
import { resolveImageRefs, snapAspectRatio } from './schema-snap.js';
import {
  PARAMS_JSON_SCHEMA,
  ParamsInput,
  applyParams,
  paramsWithoutModel,
  prefixNote,
} from './params.js';

const DEFAULT_MODEL = 'wan-2.7-image-edit';

const ALLOWED_MODELS = [
  'wan-2.7-image-edit',
  'wan-2.6-image-edit',
  'flux-edit',
  'xai-image-edit',
  'p-image-edit',
  'gpt-image-2-edit',
  'google-nano-banana',
] as const;

const InputSchema = z.object({
  prompt: z.string().min(1).max(5000).describe('Edit instruction.'),
  image_url: z
    .string()
    .url()
    .optional()
    .describe('Single reference image to edit. Pass image_urls for multi-image edits.'),
  image_urls: z
    .array(z.string().url())
    .min(1)
    .max(9)
    .optional()
    .describe('Multiple reference images (1-9). Used for composition/multi-ref edits.'),
  image_path: z
    .string()
    .min(1)
    .optional()
    .describe(
      'Absolute local file path. Skill uploads it (24h temp storage) and edits it. Prefer over image_url when the user has the file on disk.',
    ),
  image_paths: z
    .array(z.string().min(1))
    .min(1)
    .max(9)
    .optional()
    .describe(
      'Multiple absolute local file paths (1-9) for multi-image edits. Each uploaded to 24h temp storage before dispatch.',
    ),
  model: z
    .enum(ALLOWED_MODELS)
    .optional()
    .describe(
      'Override the default edit model. Defaults to wan-2.7-image-edit (most popular).',
    ),
  aspect_ratio: z
    .string()
    .optional()
    .describe('Aspect ratio when supported (e.g. "1:1", "16:9", "match_input_image").'),
  params: ParamsInput,
});

type Input = z.infer<typeof InputSchema>;

const InputJsonSchema = {
  type: 'object',
  properties: {
    prompt: { type: 'string', description: 'Edit instruction.' },
    image_url: {
      type: 'string',
      format: 'uri',
      description: 'Single image to edit. Ignored when image_urls is set; pass image_urls for multi-image edits.',
    },
    image_urls: {
      type: 'array',
      items: { type: 'string', format: 'uri' },
      minItems: 1,
      maxItems: 9,
      description:
        'Multiple reference images (1-9), most important first. Models that take fewer keep the first ones and the result says how many were dropped.',
    },
    image_path: {
      type: 'string',
      description:
        'Absolute local image path (JPEG, PNG, WebP, GIF). Skill uploads it (24h temp storage) and edits the resulting URL. Ignored when image_url or image_paths is set.',
    },
    image_paths: {
      type: 'array',
      items: { type: 'string' },
      minItems: 1,
      maxItems: 9,
      description:
        'Multiple absolute local image paths (1-9). Each is uploaded to 24h temp storage and appended after any image_urls.',
    },
    model: {
      type: 'string',
      enum: [...ALLOWED_MODELS],
      description: 'Override edit model. Default: wan-2.7-image-edit.',
    },
    aspect_ratio: {
      type: 'string',
      description:
        'Output aspect ratio, e.g. "1:1", "16:9", "match_input_image". Snapped to the nearest ratio the model supports, and dropped if the model has no aspect_ratio field.',
    },
    params: PARAMS_JSON_SCHEMA,
  },
  required: ['prompt'],
} as const;

/** OFFLINE FALLBACK ONLY — used when GET /schema is unreachable.
 *
 *  This used to be the primary path and it was wrong for half the
 *  allowlist: flux-edit got `image_url` when its schema requires
 *  `input_image_1` (every flux-edit call failed), gpt-image-2-edit got
 *  `image_url` when it only takes `image_urls` (single-image edits failed
 *  while 2-8 worked), and nothing clamped to maxItems. buildBody now asks
 *  the model's published schema first; this map is the last resort when we
 *  cannot reach it, so its entries are best-effort. */
function buildPayload(
  apiId: string,
  input: Input,
): { prompt: string; [key: string]: unknown } {
  const urls = input.image_urls && input.image_urls.length > 0
    ? input.image_urls
    : input.image_url
      ? [input.image_url]
      : [];

  switch (apiId) {
    case 'wan-2.7-image-edit':
    case 'wan-2.6-image-edit':
      return {
        prompt: input.prompt,
        image_urls: urls,
        // wan-edit uses `size` not aspect_ratio. Default 2K, let model defaults handle it otherwise.
      };
    case 'p-image-edit':
      return {
        prompt: input.prompt,
        images: urls.slice(0, 5),
        ...(input.aspect_ratio ? { aspect_ratio: input.aspect_ratio } : {}),
      };
    case 'flux-edit':
      // Schema keys the reference as input_image_1 (legacy alias:
      // input_image). `image_url` is not a field it has.
      return {
        prompt: input.prompt,
        input_image_1: urls[0],
        ...(input.aspect_ratio ? { aspect_ratio: input.aspect_ratio } : {}),
      };
    case 'gpt-image-2-edit':
      // image_urls only, min 1 max 8 — never image_url.
      return {
        prompt: input.prompt,
        image_urls: urls.slice(0, 8),
        ...(input.aspect_ratio ? { aspect_ratio: input.aspect_ratio } : {}),
      };
    case 'xai-image-edit':
      return {
        prompt: input.prompt,
        image_url: urls[0],
        ...(input.aspect_ratio ? { aspect_ratio: input.aspect_ratio } : {}),
      };
    case 'google-nano-banana':
      // Nano Banana accepts image_input as an array of URLs.
      return {
        prompt: input.prompt,
        image_input: urls,
        ...(input.aspect_ratio ? { aspect_ratio: input.aspect_ratio } : {}),
      };
    default:
      return {
        prompt: input.prompt,
        image_url: urls[0],
      };
  }
}

/** Build the request body, asking the model's published schema where its
 *  reference images go and how many it takes. Falls back to the static map
 *  above only when the schema is unreachable. */
async function buildBody(
  apiId: string,
  input: Input,
  ctx: SkillContext,
): Promise<{ body: { prompt: string; [key: string]: unknown }; dropped: number }> {
  const urls =
    input.image_urls && input.image_urls.length > 0
      ? input.image_urls
      : input.image_url
        ? [input.image_url]
        : [];

  const refs = await resolveImageRefs(apiId, urls, ctx.client);
  if (!refs) return { body: buildPayload(apiId, input), dropped: 0 };

  const fallback = buildPayload(apiId, input);
  const body: { prompt: string; [key: string]: unknown } = { ...fallback };
  // Drop whatever key the fallback guessed; the declaration/schema is
  // authoritative.
  for (const key of ['image_url', 'image_urls', 'images', 'image_input', 'input_image_1']) {
    if (key !== refs.key) delete body[key];
  }
  body.prompt = input.prompt;
  body[refs.key] = refs.value;
  if (refs.also) Object.assign(body, refs.also);
  return { body, dropped: refs.dropped };
}

async function run(input: Input, ctx: SkillContext): Promise<SkillResult> {
  const paramsGate = paramsWithoutModel(input.params, input.model);
  if (paramsGate) return { kind: 'text', text: paramsGate };

  // Resolve any local paths into URLs first. image_paths takes precedence
  // over image_path; both merge into the URL list the buildPayload step
  // already understands. Explicit URLs always win — paths are a fallback
  // for "I only have a local file."
  let resolved: Input = input;
  try {
    if (input.image_paths && input.image_paths.length > 0) {
      const urls = await uploadLocalFiles(input.image_paths, ctx);
      resolved = {
        ...input,
        image_urls: [...(input.image_urls ?? []), ...urls],
      };
    } else if (input.image_path && !input.image_url) {
      const url = await uploadLocalFile(input.image_path, ctx);
      resolved = { ...input, image_url: url };
    }
  } catch (err) {
    if (err instanceof SkillUploadError) {
      return { kind: 'text', text: `pixeldojo_edit (upload): ${err.userMessage}` };
    }
    throw err;
  }

  if (
    !resolved.image_url &&
    (!resolved.image_urls || resolved.image_urls.length === 0)
  ) {
    return {
      kind: 'text',
      text:
        'pixeldojo_edit requires at least one reference image. Pass image_url / image_urls (hosted URL) or image_path / image_paths (local file).',
    };
  }

  const apiId = resolved.model ?? DEFAULT_MODEL;
  resolved = {
    ...resolved,
    aspect_ratio: await snapAspectRatio(apiId, resolved.aspect_ratio, ctx.client),
  };
  const { body, dropped } = await buildBody(apiId, resolved, ctx);
  const droppedNote =
    dropped > 0
      ? ` (${dropped} reference${dropped === 1 ? '' : 's'} dropped — ${apiId} accepts fewer)`
      : '';
  const paramsNote = applyParams(body, input.params, input.model, apiId);

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
        ? `Edit job ${submitted.jobId} completed but returned no assets.`
        : urls.length === 1
          ? `Edit complete${droppedNote}. Asset: ${urls[0]}`
          : `Edit produced ${urls.length} assets${droppedNote}. URLs: ${urls.join(', ')}`,
    ),
    paramsNote,
  );
}

export const editSkill: SkillModule<Input> = {
  name: 'pixeldojo_edit',
  description:
    'Edit an existing image with a text instruction. Defaults to wan-2.7-image-edit; pass `model` to pick another edit-capable apiId. Supports up to 9 reference images for multi-image composition. For reference images: pass image_url(s) for hosted URLs or image_path(s) for absolute local file paths (skill uploads to 24h temp storage automatically).',
  hostedDescription:
    'Edit an existing image with a text instruction. Defaults to wan-2.7-image-edit; pass `model` to pick another edit-capable apiId. Supports up to 9 reference images for multi-image composition. Pass reference images as public http(s) URLs via image_url or image_urls.',
  inputZod: InputSchema,
  inputJsonSchema: InputJsonSchema,
  allowedModels: [...ALLOWED_MODELS],
  defaultModel: DEFAULT_MODEL,
  run,
};
