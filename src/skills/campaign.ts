/**
 * pixeldojo_campaign — agentic skill that turns one URL (or a product
 * profile) into a coherent multi-asset launch package.
 *
 * Composes existing PixelDojo tools server-side:
 *   1. Resolve product (via /api/v1/extract-product if `productUrl`).
 *   2. Generate hero (Seedream 4 / GPT Image 2 / Flux 2 by mode).
 *   3. Generate N lifestyle variants in parallel.
 *   4. Generate one vertical video off the hero (Seedance 2 / Kling).
 *
 * Returns a CampaignResult: full asset list when everything resolves in
 * the 30s sync window, or a handoff with campaignId to poll via
 * `pixeldojo_campaign_status`.
 */
import { z } from 'zod';
import {
  type SkillContext,
  type SkillModule,
  type SkillResult,
} from './types.js';

const InputSchema = z
  .object({
    productUrl: z
      .string()
      .url()
      .optional()
      .describe('Product page URL. We extract name + description + images automatically.'),
    product: z
      .object({
        name: z.string().min(1).max(200),
        description: z.string().max(2000).optional(),
        images: z.array(z.string().url()).max(5).optional(),
      })
      .optional()
      .describe('Manual product fields, used when productUrl is omitted.'),
    tone: z
      .string()
      .max(120)
      .optional()
      .describe('Optional creative direction ("premium minimalist", "playful Y2K"). Threaded through every prompt.'),
    variants: z
      .number()
      .int()
      .min(1)
      .max(8)
      .optional()
      .describe('Lifestyle shots in addition to the hero (default 4, max 8).'),
    includeVideo: z
      .boolean()
      .optional()
      .describe('Whether to also generate a vertical launch video (default true).'),
    videoAspectRatio: z
      .enum(['9:16', '16:9', '1:1'])
      .optional()
      .describe('Aspect ratio of the launch video (default 9:16 for Reels/TikTok).'),
    videoMode: z
      .enum(['lifestyle', 'cgi', 'ugc', 'skip'])
      .optional()
      .describe('Video styling — lifestyle (default), cgi, ugc, or skip to omit video.'),
  })
  .refine((v) => v.productUrl || v.product, {
    message: 'productUrl or product is required',
    path: ['productUrl'],
  });

type Input = z.infer<typeof InputSchema>;

const InputJsonSchema = {
  type: 'object',
  properties: {
    productUrl: {
      type: 'string',
      format: 'uri',
      description:
        'Product page URL; name, description and images are extracted automatically. Pass this or `product` (one is required); when both are set, productUrl wins.',
    },
    product: {
      type: 'object',
      description: 'Manual product profile, used when productUrl is omitted.',
      properties: {
        name: { type: 'string', description: 'Product name (required).' },
        description: { type: 'string', description: 'Optional product description.' },
        images: {
          type: 'array',
          items: { type: 'string', format: 'uri' },
          maxItems: 5,
          description: 'Up to 5 hosted product photo URLs.',
        },
      },
      required: ['name'],
    },
    tone: {
      type: 'string',
      description: 'Optional creative direction ("premium minimalist", "playful Y2K"), threaded through every prompt.',
    },
    variants: {
      type: 'integer',
      minimum: 1,
      maximum: 8,
      description: 'Lifestyle shots in addition to the hero (default 4).',
    },
    includeVideo: { type: 'boolean', description: 'Also render a launch video (default true).' },
    videoAspectRatio: {
      type: 'string',
      enum: ['9:16', '16:9', '1:1'],
      description: 'Launch video aspect ratio (default 9:16).',
    },
    videoMode: {
      type: 'string',
      enum: ['lifestyle', 'cgi', 'ugc', 'skip'],
      description: 'Launch video styling: lifestyle (default), cgi, ugc, or skip for no video.',
    },
  },
  // productUrl-or-product is enforced by the Zod refine and the server; no
  // root-level oneOf (some clients reject root unions — see ad.ts).
} as const;

interface CampaignAsset {
  role: string;
  kind: 'image' | 'video';
  url: string;
  apiId: string;
  jobId: string;
  variantIndex?: number;
}

interface CampaignResultShape {
  kind: 'campaign' | 'handoff';
  campaignId: string;
  assets?: CampaignAsset[];
  product?: { name: string; description?: string; sourceUrl?: string };
  totalCreditCost?: number;
  warnings?: string[];
  message?: string;
  statusUrl?: string;
  subJobs?: Array<{ jobId: string; role: string; status: string }>;
}

interface ClientWithCampaign {
  runCampaign: (input: Input) => Promise<CampaignResultShape>;
}

async function run(input: Input, ctx: SkillContext): Promise<SkillResult> {
  // The SDK exposes `runCampaign` on PixelDojoClient; we narrow via a
  // structural cast so this skill compiles even before the SDK type
  // updates land in the consuming app.
  const client = ctx.client as unknown as ClientWithCampaign;
  const result = await client.runCampaign(input);

  if (result.kind === 'campaign') {
    const assets = result.assets ?? [];
    const lines = [
      `Campaign ${result.campaignId} for "${result.product?.name ?? 'product'}":`,
      ...assets.map(
        (a) =>
          `  - ${a.role}${a.variantIndex !== undefined ? ` #${a.variantIndex}` : ''} (${a.kind}, ${a.apiId}): ${a.url}`,
      ),
      '',
      `Total credits: ${result.totalCreditCost ?? 0}.`,
      ...(result.warnings && result.warnings.length > 0
        ? [`Warnings: ${result.warnings.join('; ')}`]
        : []),
    ];
    return {
      kind: 'assets',
      text: lines.join('\n'),
      assetUrls: assets.map((a) => a.url),
    };
  }

  // Handoff path — campaign exceeded 30 s sync budget.
  return {
    kind: 'handoff',
    text:
      result.message ??
      `Campaign ${result.campaignId} queued. Poll via pixeldojo_campaign_status.`,
    jobId: result.campaignId,
    statusUrl: result.statusUrl ?? ctx.buildStatusUrl(result.campaignId),
  };
}

export const campaignSkill: SkillModule<Input> = {
  name: 'pixeldojo_campaign',
  description:
    'Generate a coherent product launch package (hero image + N lifestyle variants + optional vertical video) from one URL or product profile. Composes hero / lifestyle / video models server-side; returns assets in one call or a handoff with campaignId to poll via pixeldojo_campaign_status.',
  inputZod: InputSchema,
  inputJsonSchema: InputJsonSchema,
  // Composition skill — internal sub-jobs route to per-tool models, no
  // single allowed-models list applies here.
  allowedModels: [],
  defaultModel: '',
  run,
};
