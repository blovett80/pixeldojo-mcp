/**
 * pixeldojo_library — search your own generation history.
 *
 * Every asset the agent generated via API/MCP, plus results the user kept
 * (saved or downloaded) in the web app. Returns URLs that can be passed
 * straight back into pixeldojo_generate, _edit, _character, or _upscale as
 * reference inputs — "find yesterday's hero shot and make three variants."
 */
import { z } from 'zod';
import {
  type SkillContext,
  type SkillModule,
  type SkillResult,
} from './types.js';

const InputSchema = z.object({
  q: z
    .string()
    .optional()
    .describe('Substring match against the prompt that produced the asset.'),
  model: z.string().optional().describe('Restrict to a single model (apiId).'),
  modality: z
    .enum(['image', 'video', 'audio'])
    .optional()
    .describe('Restrict to one output type.'),
  limit: z.number().int().min(1).max(50).optional().describe('Max results (default 10).'),
});

type Input = z.infer<typeof InputSchema>;

const InputJsonSchema = {
  type: 'object',
  properties: {
    q: {
      type: 'string',
      description: 'Substring match against the prompt that produced the asset. Omit to list the newest items.',
    },
    model: { type: 'string', description: 'Only assets from this model apiId.' },
    modality: {
      type: 'string',
      enum: ['image', 'video', 'audio'],
      description: 'Only this output type.',
    },
    limit: { type: 'integer', minimum: 1, maximum: 50, description: 'Max results (default 10).' },
  },
  required: [],
} as const;

async function run(input: Input, ctx: SkillContext): Promise<SkillResult> {
  const res = await ctx.client.listLibrary({
    q: input.q,
    model: input.model,
    modality: input.modality,
    limit: input.limit ?? 10,
  });

  if (res.items.length === 0) {
    return {
      kind: 'text',
      text: input.q
        ? `No library items match "${input.q}". Try a broader query, or omit q to list recent generations.`
        : 'Your library is empty. Generate something with pixeldojo_generate first.',
    };
  }

  const lines = res.items.map((it) => {
    const parts = [
      `- ${it.url}`,
      it.modality ? `[${it.modality}]` : null,
      it.model ? `model=${it.model}` : null,
      `(${it.source}, ${it.createdAt.slice(0, 10)})`,
      it.prompt ? `"${it.prompt.slice(0, 90)}${it.prompt.length > 90 ? '…' : ''}"` : null,
    ].filter(Boolean);
    return parts.join(' ');
  });

  return {
    kind: 'text',
    text: `${res.items.length} library item(s):\n${lines.join('\n')}\n\nPass any URL back into pixeldojo_generate, pixeldojo_edit, pixeldojo_character, or pixeldojo_upscale as a reference input.`,
  };
}

export const librarySkill: SkillModule<Input> = {
  name: 'pixeldojo_library',
  description:
    'Search your media library: saved My Media items (permanent) and recent API/MCP generations (deleted 1 hour after they finish), newest first. Returns asset URLs to reuse as reference inputs.',
  inputZod: InputSchema,
  inputJsonSchema: InputJsonSchema,
  allowedModels: [],
  defaultModel: '',
  run,
};
