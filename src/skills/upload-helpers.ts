/**
 * Shared helper: read a local file and upload it to PixelDojo's 24h temp
 * bucket, returning the public URL. Used by `:generate` and `:edit` to
 * accept `image_path` / `image_paths` alongside the URL-based fields so
 * agents can hand off a local file in one step instead of chaining
 * `:upload` first.
 *
 * Throws a `SkillUploadError` on any failure — caller turns it into a
 * SkillResult text response.
 */
import { readFile, stat } from 'node:fs/promises';
import { extname, basename } from 'node:path';
import type { SkillContext } from './types.js';

const MAX_IMAGE_BYTES = 50 * 1024 * 1024;
const MAX_VIDEO_BYTES = 200 * 1024 * 1024;
const MAX_AUDIO_BYTES = 50 * 1024 * 1024;

const EXT_TO_MIME: Record<string, string> = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mov': 'video/quicktime',
  // Audio: the server checks the bytes match (a Film Studio song, song_path).
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.m4a': 'audio/mp4',
  '.aac': 'audio/aac',
  '.ogg': 'audio/ogg',
  '.flac': 'audio/flac',
};

export class SkillUploadError extends Error {
  constructor(public readonly userMessage: string) {
    super(userMessage);
    this.name = 'SkillUploadError';
  }
}

export const HOSTED_LOCAL_PATH_MESSAGE =
  'Local file paths are not available on the hosted PixelDojo MCP server (it cannot see your disk). ' +
  'Pass a public http(s) URL instead (image_url / image_urls / video_url / audio_urls / product_image_urls), ' +
  'or install the local server (npx @pixeldojo/mcp init) to use files on your machine.';

type UploadCtx = Pick<SkillContext, 'client' | 'localFiles'>;

export async function uploadLocalFile(path: string, ctx: UploadCtx): Promise<string> {
  // Checked before any fs call: on the hosted server "local" is our container.
  if (ctx.localFiles !== true) throw new SkillUploadError(HOSTED_LOCAL_PATH_MESSAGE);
  const ext = extname(path).toLowerCase();
  const mime = EXT_TO_MIME[ext];
  if (!mime) {
    throw new SkillUploadError(
      `Unsupported file extension "${ext || '(none)'}" for "${path}". Allowed: ${Object.keys(EXT_TO_MIME).join(', ')}.`,
    );
  }

  let size: number;
  try {
    const info = await stat(path);
    if (!info.isFile()) {
      throw new SkillUploadError(`"${path}" is not a file.`);
    }
    size = info.size;
  } catch (err) {
    if (err instanceof SkillUploadError) throw err;
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code === 'ENOENT') {
      throw new SkillUploadError(
        `File not found at "${path}". Pass an absolute path.`,
      );
    }
    throw new SkillUploadError(
      `Cannot read "${path}": ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  const isImage = mime.startsWith('image/');
  const isAudio = mime.startsWith('audio/');
  const limit = isImage ? MAX_IMAGE_BYTES : isAudio ? MAX_AUDIO_BYTES : MAX_VIDEO_BYTES;
  if (size > limit) {
    const gotMB = (size / 1024 / 1024).toFixed(1);
    const limitMB = (limit / 1024 / 1024).toFixed(0);
    throw new SkillUploadError(
      `"${basename(path)}" is ${gotMB}MB; limit for ${isImage ? 'images' : isAudio ? 'audio' : 'videos'} is ${limitMB}MB. Downscale or re-encode and try again.`,
    );
  }

  const buffer = await readFile(path);
  const blob = new Blob([new Uint8Array(buffer)], { type: mime });
  const filename = basename(path);
  const response = await ctx.client.uploadImage(blob, filename);
  return response.url;
}

export async function uploadLocalFiles(
  paths: readonly string[],
  ctx: UploadCtx,
): Promise<string[]> {
  return Promise.all(paths.map((p) => uploadLocalFile(p, ctx)));
}
