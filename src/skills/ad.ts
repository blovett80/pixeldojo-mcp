/**
 * pixeldojo_ad — the Marketing Studio as an agent skill.
 *
 * One call: a product (URL or images) + an ad style → a rendered product
 * video ad with voiceover, on the same backbone and prompt assembly the
 * /marketing-studio composer uses. Prompt assembly happens server-side
 * (POST /api/v1/ads/run), so new styles ship without a package release.
 *
 * Built for automation: agents can pull a store URL, render an ad in a
 * chosen style, and hand the video to a posting workflow (their own app,
 * Cowork, a scheduler). Style catalog: GET /api/v1/marketing/presets.
 */
import { z } from 'zod';
import {
  pollResultToSkillResult,
  type SkillContext,
  type SkillModule,
  type SkillResult,
} from './types.js';
import { pollJobUntilDoneOrHandoff } from '../poll.js';
import { uploadLocalFile } from './upload-helpers.js';

const InputSchema = z
  .object({
    style: z
      .string()
      .max(80)
      .optional()
      .describe(
        'Ad style slug (default ugc-testimonial). Catalog: GET /api/v1/marketing/presets — e.g. ugc-testimonial, unboxing-reveal, unboxing-asmr, virtual-try-on, street-style, product-showcase, macro-details, crush-test, hyper-motion, before-after, day-in-the-life, the-gift, tv-spot.',
      ),
    product_url: z
      .string()
      .url()
      .optional()
      .describe('Product page URL. Name, description, and images are extracted automatically.'),
    product_name: z.string().max(200).optional(),
    product_description: z.string().max(2000).optional(),
    product_image_urls: z.array(z.string().url()).max(5).optional(),
    product_image_paths: z
      .array(z.string())
      .max(5)
      .optional()
      .describe('Absolute local paths; uploaded to 24h temp storage automatically.'),
    character_image_urls: z
      .array(z.string().url())
      .max(4)
      .optional()
      .describe('Presenter reference images for a consistent on-camera character.'),
    character_image_paths: z.array(z.string()).max(4).optional(),
    location_description: z
      .string()
      .max(1500)
      .optional()
      .describe('Where the ad takes place ("a sunlit Parisian cafe"). Text is enough; no image needed.'),
    location_image_url: z.string().url().optional(),
    hook: z
      .string()
      .max(1000)
      .optional()
      .describe('The opening visual beat (first 1-2 seconds). Omit to use the style default.'),
    script: z
      .string()
      .max(1000)
      .optional()
      .describe('The exact spoken line, voiced word for word. Omit and the presenter improvises.'),
    quality: z.enum(['mini', 'fast', 'high']).optional(),
    resolution: z
      .enum(['480p', '720p', '1080p', '4k'])
      .optional()
      .describe('1080p/4k require quality "high".'),
    aspect_ratio: z.enum(['16:9', '4:3', '1:1', '3:4', '9:16', '21:9']).optional(),
    duration: z.number().int().min(4).max(15).optional(),
  })
  .refine(
    (v) => v.product_url || ((v.product_image_urls?.length || v.product_image_paths?.length) && v.product_name),
    {
      message: 'Pass product_url, OR product_name plus product_image_urls/product_image_paths.',
      path: ['product_url'],
    },
  );

type Input = z.infer<typeof InputSchema>;

const InputJsonSchema = {
  type: 'object',
  properties: {
    style: {
      type: 'string',
      description:
        'Ad style slug (default ugc-testimonial). Catalog: GET /api/v1/marketing/presets — e.g. ugc-testimonial, unboxing-reveal, unboxing-asmr, virtual-try-on, street-style, mirror-fit-check, pro-try-on, product-showcase, macro-details, secret-hack-reveal, crush-test, hyper-motion, before-after, day-in-the-life, the-gift, tv-spot, gadget-saved-me, selfie-testimonial, direct-to-camera, pack-an-order, mystery-box.',
    },
    product_url: {
      type: 'string',
      format: 'uri',
      description:
        'Product page URL. Name, description, and images are extracted automatically. Pass this, or product_name plus product images; when set, the product_* fields are ignored.',
    },
    product_name: {
      type: 'string',
      description: 'Product name. Required with product images when there is no product_url.',
    },
    product_description: { type: 'string', description: 'Optional product description (no product_url case).' },
    product_image_urls: {
      type: 'array',
      items: { type: 'string', format: 'uri' },
      maxItems: 5,
      description: 'Up to 5 hosted product photos (no product_url case).',
    },
    product_image_paths: {
      type: 'array',
      items: { type: 'string' },
      maxItems: 5,
      description: 'Up to 5 absolute local product image paths; uploaded to 24h temp storage automatically.',
    },
    character_image_urls: {
      type: 'array',
      items: { type: 'string', format: 'uri' },
      maxItems: 4,
      description: 'Presenter reference images for a consistent on-camera character.',
    },
    character_image_paths: {
      type: 'array',
      items: { type: 'string' },
      maxItems: 4,
      description: 'Absolute local presenter image paths; uploaded to 24h temp storage automatically.',
    },
    location_description: {
      type: 'string',
      description: 'Where the ad takes place ("a sunlit Parisian cafe"). Text is enough.',
    },
    location_image_url: {
      type: 'string',
      format: 'uri',
      description: 'Optional reference photo of the location.',
    },
    hook: {
      type: 'string',
      description: 'The opening visual beat (first 1-2 seconds). Omit to use the style default.',
    },
    script: {
      type: 'string',
      description: 'The exact spoken line, voiced word for word. Omit and the presenter improvises.',
    },
    quality: {
      type: 'string',
      enum: ['mini', 'fast', 'high'],
      description: "Render tier. Omitted or unsupported by the ad engine, the engine's default tier is used.",
    },
    resolution: {
      type: 'string',
      enum: ['480p', '720p', '1080p', '4k'],
      description:
        '1080p/4k require quality "high"; without it, or when the engine lacks the value, the engine default resolution is used.',
    },
    aspect_ratio: {
      type: 'string',
      enum: ['16:9', '4:3', '1:1', '3:4', '9:16', '21:9'],
      description: "Defaults to the style's own aspect ratio; a value the engine does not support falls back to it.",
    },
    duration: {
      type: 'integer',
      minimum: 4,
      maximum: 15,
      description: "Ad length in seconds. Defaults to the style's length; clamped to what the engine allows.",
    },
  },
  // "product_url OR product_name+images" is enforced by the server and the
  // Zod refine; no root-level oneOf (Grok rejects non-object root unions).
} as const;

interface AdRunResponseShape {
  jobId: string;
  status: string;
  statusUrl: string;
  creditCost?: number;
  ad?: { style: string; prompt: string; product?: { name: string } };
}

interface ClientWithAd {
  runAd: (input: Record<string, unknown>) => Promise<AdRunResponseShape>;
}

async function run(input: Input, ctx: SkillContext): Promise<SkillResult> {
  // Local files → 24h temp URLs, same affordance as pixeldojo_generate.
  const productImages = [
    ...(input.product_image_urls ?? []),
    ...(await Promise.all((input.product_image_paths ?? []).map((p) => uploadLocalFile(p, ctx)))),
  ];
  const characterImages = [
    ...(input.character_image_urls ?? []),
    ...(await Promise.all((input.character_image_paths ?? []).map((p) => uploadLocalFile(p, ctx)))),
  ];

  const body: Record<string, unknown> = {
    style: input.style,
    product_url: input.product_url,
    product:
      !input.product_url && input.product_name
        ? {
            name: input.product_name,
            description: input.product_description,
            images: productImages,
          }
        : undefined,
    character_images: characterImages.length > 0 ? characterImages : undefined,
    location:
      input.location_description || input.location_image_url
        ? { description: input.location_description, image_url: input.location_image_url }
        : undefined,
    hook: input.hook,
    script: input.script,
    quality: input.quality,
    resolution: input.resolution,
    aspect_ratio: input.aspect_ratio,
    duration: input.duration,
  };

  const client = ctx.client as unknown as ClientWithAd;
  const submitted = await client.runAd(body);

  const result = await pollJobUntilDoneOrHandoff(
    submitted.jobId,
    (id) => ctx.client.getJob(id),
    ctx.buildStatusUrl,
    {
      now: ctx.pollOverrides?.now,
      sleep: ctx.pollOverrides?.sleep,
    },
  );

  const styleLabel = submitted.ad?.style ?? input.style ?? 'ugc-testimonial';
  return pollResultToSkillResult(result, (urls) =>
    urls.length === 0
      ? `Ad job ${submitted.jobId} completed but returned no assets.`
      : `Ad rendered (style: ${styleLabel}${submitted.ad?.product?.name ? `, product: ${submitted.ad.product.name}` : ''}). Video: ${urls[0]}`,
  );
}

export const adSkill: SkillModule<Input> = {
  name: 'pixeldojo_ad',
  description:
    'Marketing Studio: turn a product into a rendered video ad with voiceover. Requires `product_url` (name, description and images are extracted), or `product_name` plus product_image_urls / product_image_paths. Pick a `style` slug (default ugc-testimonial; full catalog at GET https://pixeldojo.ai/api/v1/marketing/presets), and optionally add presenter reference images, a location, a hook, and the exact spoken script. Returns the video URL, or a jobId to check with pixeldojo_status.',
  hostedDescription:
    'Marketing Studio: turn a product into a rendered video ad with voiceover. Requires `product_url` (name, description and images are extracted), or `product_name` plus product_image_urls (public http(s) URLs). Pick a `style` slug (default ugc-testimonial; full catalog at GET https://pixeldojo.ai/api/v1/marketing/presets), and optionally add presenter reference images, a location, a hook, and the exact spoken script. Returns the video URL, or a jobId to check with pixeldojo_status.',
  inputZod: InputSchema as z.ZodType<Input>,
  inputJsonSchema: InputJsonSchema as unknown as Record<string, unknown>,
  // Composition skill — the server routes to the ad engine internally.
  allowedModels: [],
  defaultModel: '',
  run,
};
