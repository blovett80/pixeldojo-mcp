/**
 * pixeldojo_from_url — paste a product URL, get back a ResolvedProduct.
 *
 * Hits the public /api/v1/extract-product endpoint. No credits consumed.
 * pixeldojo_campaign and pixeldojo_ad run the same extraction themselves
 * when handed a product URL; this is the standalone view of it — removes
 * the cold-start problem of "describe your product to me first."
 */
import { z } from 'zod';
import {
  type SkillContext,
  type SkillModule,
  type SkillResult,
} from './types.js';

const InputSchema = z.object({
  url: z
    .string()
    .min(1)
    .max(2048)
    .describe('Product page URL. Shopify, BigCommerce, WooCommerce, or any page with JSON-LD / OpenGraph product metadata.'),
});

type Input = z.infer<typeof InputSchema>;

const InputJsonSchema = {
  type: 'object',
  properties: {
    url: {
      type: 'string',
      description:
        'Product page URL. Shopify, BigCommerce, WooCommerce, or any page with JSON-LD / OpenGraph product metadata.',
    },
  },
  required: ['url'],
} as const;

async function run(input: Input, ctx: SkillContext): Promise<SkillResult> {
  const product = await ctx.client.extractProduct(input.url);

  const summary = [
    `Product: ${product.name}`,
    product.description ? `Description: ${truncate(product.description, 280)}` : null,
    `Images (${product.images.length}): ${product.images.slice(0, 3).join(', ')}${
      product.images.length > 3 ? `, +${product.images.length - 3} more` : ''
    }`,
    `Source strategy: ${product.source}`,
  ]
    .filter(Boolean)
    .join('\n');

  return {
    kind: 'text',
    text: summary,
  };
}

function truncate(input: string, max: number): string {
  if (input.length <= max) return input;
  return input.slice(0, max - 3) + '...';
}

export const fromUrlSkill: SkillModule<Input> = {
  name: 'pixeldojo_from_url',
  description:
    'Extract a product profile from a product page URL: name, description, image URLs (the first three are listed), and the extraction method used. Works on Shopify, BigCommerce, WooCommerce, or any page with JSON-LD / OpenGraph product metadata. Free. pixeldojo_campaign and pixeldojo_ad accept a product URL and run this extraction themselves; call this directly to check the product data first, or to reuse its images in other tools.',
  inputZod: InputSchema,
  inputJsonSchema: InputJsonSchema,
  // No model dispatch — this skill calls a server-side scrape, not a generation.
  allowedModels: [],
  defaultModel: '',
  run,
};
