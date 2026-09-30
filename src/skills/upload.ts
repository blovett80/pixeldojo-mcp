/**
 * pixeldojo_upload — turn a local file path into a hosted URL.
 *
 * Bridges the "user has a local image/video" → "API needs a URL" gap that
 * blocks reference-image workflows in Claude Code, Cursor, etc. The MCP
 * runs in the user's environment so it has fs access; we read the bytes,
 * POST them to /api/v1/upload, and return the temp CDN URL. Storage
 * auto-expires after 24h (R2 lifecycle policy on `pixeldojotemp`).
 *
 * No credits consumed.
 */
import { z } from 'zod';
import { basename } from 'node:path';
import {
  type SkillContext,
  type SkillModule,
  type SkillResult,
} from './types.js';
import { SkillUploadError, uploadLocalFile } from './upload-helpers.js';

const InputSchema = z.object({
  path: z
    .string()
    .min(1)
    .max(4096)
    .describe(
      'Absolute local file path to upload. JPEG, PNG, WebP, GIF (≤50MB), MP4, WebM, MOV (≤200MB) or MP3, WAV, M4A, AAC, OGG, FLAC audio (≤50MB). Returns a public URL on the temp CDN; storage auto-expires after 24 hours.',
    ),
});

type Input = z.infer<typeof InputSchema>;

const InputJsonSchema = {
  type: 'object',
  properties: {
    path: {
      type: 'string',
      description:
        'Absolute local file path. Allowed: JPEG, PNG, WebP, GIF (≤50MB), MP4, WebM, MOV (≤200MB) or MP3, WAV, M4A, AAC, OGG, FLAC audio (≤50MB). Returns a public URL on the temp CDN; auto-expires after 24h.',
    },
  },
  required: ['path'],
} as const;

async function run(input: Input, ctx: SkillContext): Promise<SkillResult> {
  let url: string;
  try {
    url = await uploadLocalFile(input.path, ctx);
  } catch (err) {
    if (err instanceof SkillUploadError) {
      return { kind: 'text', text: `pixeldojo_upload: ${err.userMessage}` };
    }
    throw err;
  }
  return {
    kind: 'text',
    text:
      `Uploaded ${basename(input.path)} → ${url}\n` +
      `(temp storage; auto-deletes in ~24h. Pass this URL as image_url, video_url for a clip, or song_url on pixeldojo_film for a song, to any pixeldojo tool that takes one.)`,
  };
}

export const uploadSkill: SkillModule<Input> = {
  name: 'pixeldojo_upload',
  description:
    'Upload a local image, video or audio file (JPEG, PNG, WebP, GIF up to 50MB; MP4, WebM, MOV up to 200MB; MP3, WAV, M4A, AAC, OGG, FLAC up to 50MB) and get back a public URL that expires after 24 hours. Free. Pass an audio URL as song_url to pixeldojo_film for a music video. Pass the URL as image_url (stills) or video_url (clips) to tools that take hosted URLs only, such as pixeldojo_character, pixeldojo_storyboard and pixeldojo_upscale. pixeldojo_generate, pixeldojo_edit and pixeldojo_ad take local paths directly and need no separate upload.',
  inputZod: InputSchema,
  inputJsonSchema: InputJsonSchema,
  allowedModels: [],
  defaultModel: '',
  run,
};
