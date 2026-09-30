/**
 * pixeldojo_audio — speech, dialogue, sound effects, and music from a prompt.
 *
 * Whitelisted models: seed-audio (default; ByteDance Seed Audio 1.0 —
 * multi-character dialogue + SFX + music in one pass, up to 2 minutes) and
 * text-to-speech (plain narration). Reference clips are hosted URLs
 * addressed in the prompt as @Audio1..@Audio3. There is no local-file input:
 * /api/v1/upload accepts images and video only, so an `audio_paths` field
 * could never work and was removed (0.13.0).
 */
import { z } from 'zod';
import { pollJobUntilDoneOrHandoff } from '../poll.js';
import {
  type SkillContext,
  type SkillModule,
  type SkillResult,
  pollResultToSkillResult,
} from './types.js';

const ALLOWED = ['seed-audio', 'text-to-speech'] as const;
type AllowedModel = (typeof ALLOWED)[number];
const DEFAULT_MODEL: AllowedModel = 'seed-audio';

const InputSchema = z.object({
  prompt: z
    .string()
    .min(1)
    .describe(
      'seed-audio: a script to speak, or a scene description (dialogue, sound effects, music), up to 2048 characters; refer to audio_urls clips in order as @Audio1..@Audio3. text-to-speech: the exact text to speak, up to 10,000 characters.',
    ),
  model: z
    .string()
    .optional()
    .describe(`${DEFAULT_MODEL} (default): speech, multi-voice dialogue, effects and music in one clip, and voice cloning from audio_urls. text-to-speech: plain narration with preset voices.`),
  voice: z
    .string()
    .optional()
    .describe('text-to-speech only: voice preset (e.g. Wise_Woman, Calm_Woman, Friendly_Person; default Wise_Woman). seed-audio ignores it: describe the voice in the prompt, or clone one with audio_urls.'),
  audio_urls: z
    .array(z.string().url())
    .max(3)
    .optional()
    .describe('seed-audio only: up to 3 hosted reference clips (wav, mp3, pcm or ogg_opus, 30s / 10MB max each) for voice cloning, referenced in the prompt as @Audio1..@Audio3. Local audio files cannot be uploaded; pass URLs. Ignored by text-to-speech.'),
  output_format: z
    .string()
    .optional()
    .describe('Output format. seed-audio: mp3 (default), wav, pcm, ogg_opus. text-to-speech: mp3 (default), wav, flac, pcm.'),
  speed: z.number().min(0.5).max(2).optional().describe('Speech speed multiplier, 0.5-2 (default 1). Both models.'),
});

type Input = z.infer<typeof InputSchema>;

const InputJsonSchema = {
  type: 'object',
  properties: {
    prompt: {
      type: 'string',
      description:
        'seed-audio: a script to speak, or a scene description (dialogue, sound effects, music), up to 2048 characters; refer to audio_urls clips in order as @Audio1..@Audio3. text-to-speech: the exact text to speak, up to 10,000 characters.',
    },
    model: {
      type: 'string',
      enum: ALLOWED,
      description:
        `${DEFAULT_MODEL} (default): speech, multi-voice dialogue, effects and music in one clip, and voice cloning from audio_urls. text-to-speech: plain narration with preset voices.`,
    },
    voice: {
      type: 'string',
      description:
        'text-to-speech only: voice preset (e.g. Wise_Woman, Calm_Woman, Friendly_Person; default Wise_Woman). seed-audio ignores it: describe the voice in the prompt, or clone one with audio_urls.',
    },
    audio_urls: {
      type: 'array',
      items: { type: 'string', format: 'uri' },
      maxItems: 3,
      description:
        'seed-audio only: up to 3 hosted reference clips (wav, mp3, pcm or ogg_opus, 30s / 10MB max each) for voice cloning, referenced in the prompt as @Audio1..@Audio3. Local audio files cannot be uploaded; pass URLs. Ignored by text-to-speech.',
    },
    output_format: {
      type: 'string',
      description: 'Output format. seed-audio: mp3 (default), wav, pcm, ogg_opus. text-to-speech: mp3 (default), wav, flac, pcm.',
    },
    speed: {
      type: 'number',
      minimum: 0.5,
      maximum: 2,
      description: 'Speech speed multiplier, 0.5-2 (default 1). Both models.',
    },
  },
  required: ['prompt'],
} as const;

async function run(input: Input, ctx: SkillContext): Promise<SkillResult> {
  const requested = (input.model ?? DEFAULT_MODEL) as string;
  if (!(ALLOWED as readonly string[]).includes(requested)) {
    return {
      kind: 'text',
      text: `Unknown model "${requested}" for pixeldojo_audio. Allowed: ${ALLOWED.join(', ')}.`,
    };
  }
  const apiId = requested as AllowedModel;

  const audioUrls = input.audio_urls ?? [];

  const body: { prompt: string; [key: string]: unknown } = { prompt: input.prompt };
  if (apiId === 'seed-audio') {
    if (input.voice) body.voice = input.voice;
    if (audioUrls.length) body.audio_urls = audioUrls;
    if (input.output_format) body.output_format = input.output_format;
    if (input.speed !== undefined) body.speed = input.speed;
  } else {
    // text-to-speech takes `text` + `voice_id` instead of prompt/voice.
    body.text = input.prompt;
    delete (body as Record<string, unknown>).prompt;
    if (input.voice) body.voice_id = input.voice;
    if (input.output_format) body.audio_format = input.output_format;
    if (input.speed !== undefined) body.speed = input.speed;
  }

  const submitted = await ctx.client.run(apiId, body as { prompt: string });

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
      : `Audio ready. Asset: ${urls[0]}`,
  );
}

export const audioSkill: SkillModule<Input> = {
  name: 'pixeldojo_audio',
  description:
    'Generate audio: speech, multi-character dialogue, sound effects, and background music from one prompt (Seed Audio 1.0 by default; plain text-to-speech available). Voice cloning takes hosted reference clip URLs in audio_urls; local audio files are not accepted. Returns an audio URL, or a jobId for pixeldojo_status.',
  inputZod: InputSchema,
  inputJsonSchema: InputJsonSchema,
  allowedModels: [...ALLOWED],
  defaultModel: DEFAULT_MODEL,
  run,
};
