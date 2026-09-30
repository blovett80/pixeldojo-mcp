/**
 * Snap agent-supplied `aspect_ratio` / `duration` values to what a model's
 * real schema accepts, fetched from GET /api/v1/models/{apiId}/schema.
 *
 * The MCP package has no access to the main app's server-side model
 * catalog — it's a separate npm package that only talks to the public API
 * over HTTP — so unlike the in-app chat agent's model-router.ts, there's
 * no local catalog to consult. This does one schema fetch per apiId
 * (cached for the life of the process — the MCP server is a long-lived
 * stdio process for the session) and snaps to the nearest value the
 * schema actually allows, instead of forwarding a value verbatim that a
 * model's Zod schema rejects outright (an LLM guessing "2:3" for a
 * portrait against a model that only accepts 1:1/16:9/9:16/4:3/3:4, or a
 * duration of 10s against a model that only accepts 5 or 8).
 *
 * Every schemas-derived tri-state is meaningful and handled distinctly:
 *   - schema fetch failed (network hiccup, endpoint down) → pass the
 *     caller's value through UNCHANGED. We don't know what the model
 *     wants, so this is strictly today's pre-existing behavior, not a
 *     regression.
 *   - schema fetched OK, field absent from the model's declared
 *     properties → return undefined so the caller OMITS the key.
 *     Schemas reject unrecognized keys (additionalProperties: false), so
 *     forwarding a field a model never declared 400s regardless — this
 *     is a genuine improvement, not just a snap.
 *   - schema fetched OK, field present with an enum → snap to the
 *     numerically-nearest allowed value (aspect ratio) or nearest allowed
 *     number (duration).
 *   - schema fetched OK, field present with only min/max (duration only)
 *     → clamp into range.
 *   - schema fetched OK, field present but unconstrained → pass through.
 */
import type { PixelDojoClient } from '@pixeldojo/sdk';

interface FieldConstraint {
  type?: string;
  enum?: string[];
  minimum?: number;
  maximum?: number;
  maxItems?: number;
  minItems?: number;
}

type FieldConstraints = Record<string, FieldConstraint>;

/** One declared reference slot from the tool's `media` block, served by
 *  GET /api/v1/models/{apiId}/schema alongside the schema itself. `also` is
 *  the part no field-name search could ever find — kling's
 *  `reference_type: 'video'` is what selects the provider's clip endpoint, so
 *  the url alone lands on the still path. */
export interface MediaSlot {
  key: string;
  also?: Record<string, string | number | boolean>;
}

export type MediaKind = 'image' | 'video' | 'audio';

type MediaDeclarations = Partial<Record<MediaKind, MediaSlot>>;

interface ModelSchemaInfo {
  props: FieldConstraints;
  /** Absent when the tool declares no media slots at all. */
  media?: MediaDeclarations;
}

// Cache the in-flight PROMISE, not the resolved value — generate's
// Promise.all([snapAspectRatio, snapDuration]) fires both before either
// resolves, and a value-cache would let two identical GET /schema requests
// race on first call. Failed fetches resolve null and are evicted so a
// transient outage doesn't poison the rest of the process's lifetime.
const schemaCache = new Map<string, Promise<ModelSchemaInfo | null>>();

/** Test-only: clear the module-level schema cache so tests with different
 *  mocked schemas for the same apiId don't see a stale cached result. */
export function _resetSchemaCacheForTests(): void {
  schemaCache.clear();
}

/** Resolves null when the schema fetch itself failed (caller decides
 *  whether to fail open or closed) — distinct from a successfully-fetched
 *  schema that simply has no properties. */
function getModelInfo(
  apiId: string,
  client: PixelDojoClient,
): Promise<ModelSchemaInfo | null> {
  const cached = schemaCache.get(apiId);
  if (cached) return cached;
  // An older @pixeldojo/sdk may not have getModelSchema at all, and one that
  // does may throw synchronously — both are the "constraints unknown" case,
  // not a crash. The typeof guard states the expectation; the Promise wrapper
  // keeps a synchronous throw inside the .catch() below rather than letting it
  // escape and take the whole skill down.
  if (typeof client?.getModelSchema !== 'function') return Promise.resolve(null);
  const pending = Promise.resolve()
    .then(() => client.getModelSchema(apiId))
    .then((res) => {
      // `media` is served next to `schema` by the same endpoint but is newer
      // than the SDK's ModelSchemaResponse type, hence the cast. An older
      // deployment simply omits it and every lookup falls back to the
      // name-search below, which is the pre-media behavior.
      const body = res as unknown as {
        schema?: { properties?: FieldConstraints };
        media?: MediaDeclarations;
      };
      return { props: body.schema?.properties ?? {}, media: body.media };
    })
    .catch(() => {
      schemaCache.delete(apiId); // don't cache failures
      return null;
    });
  schemaCache.set(apiId, pending);
  return pending;
}

async function getFieldConstraints(
  apiId: string,
  client: PixelDojoClient,
): Promise<FieldConstraints | null> {
  return (await getModelInfo(apiId, client))?.props ?? null;
}

/** What to do with the caller's value when the model's constraints are
 *  UNKNOWN (schema fetch failed):
 *  - 'send' (default): pass the value through unchanged — status quo for
 *    skills that always forwarded these fields (generate/edit/storyboard).
 *  - 'omit': drop the field — for skills that historically only sent it to
 *    an allowlist of models (character), where forwarding on a fetch
 *    failure would 400 against strict schemas that never took the field. */
export interface SnapOptions {
  onUnknown?: 'send' | 'omit';
}

function parseAspectRatio(ar: string): number | null {
  const m = /^\s*(\d+)\s*:\s*(\d+)\s*$/.exec(ar);
  if (!m) return null;
  const w = Number(m[1]);
  const h = Number(m[2]);
  return h > 0 ? w / h : null;
}

function nearestAspectFromEnum(requested: string, allowed: string[]): string {
  if (allowed.includes(requested)) return requested;
  const target = parseAspectRatio(requested);
  if (target === null) return requested;
  let best = requested;
  let bestDiff = Infinity;
  for (const candidate of allowed) {
    const r = parseAspectRatio(candidate);
    if (r === null) continue;
    const diff = Math.abs(r - target);
    if (diff < bestDiff) {
      bestDiff = diff;
      best = candidate;
    }
  }
  return best;
}

/** Snap `aspect_ratio` to the nearest value the model's schema declares.
 *  Returns undefined when there's nothing to send (no value requested, or
 *  the model's schema confirms it doesn't take this field at all). */
export async function snapAspectRatio(
  apiId: string,
  requested: string | undefined,
  client: PixelDojoClient,
  opts: SnapOptions = {},
): Promise<string | undefined> {
  if (!requested) return undefined;
  const props = await getFieldConstraints(apiId, client);
  if (props === null) {
    return opts.onUnknown === 'omit' ? undefined : requested; // fetch failed
  }
  const field = props.aspect_ratio;
  if (!field) return undefined; // confirmed: this model doesn't take aspect_ratio
  if (!field.enum || field.enum.length === 0) return requested; // unconstrained string
  return nearestAspectFromEnum(requested, field.enum);
}

/**
 * Every field name a tool in the registry uses to mean "here is a reference
 * image". Agents only ever hand us one generic `image_url`; this is what it
 * gets mapped onto, per model, from the model's own schema.
 *
 * Order is specificity, not popularity: a model that declares several (Kling
 * declares start_image_url + image_urls + end_image_url) gets the field that
 * a SINGLE reference means — the start frame — not the bag of extra refs.
 * Video-input fields (video_url) are deliberately absent; the video-edit /
 * video-extend tools are mapped explicitly in generate.ts because they also
 * remap duration, and every other clip slot arrives declared (see
 * resolveMediaSlot).
 *
 * This is the FALLBACK for models that declare no `media`. A declared slot
 * always wins — see resolveMediaSlot.
 *
 * tests/contracts/film-studio-engines-registered.test.ts fails if any Film
 * Studio clip engine (or any registered reference-capable video tool) grows
 * a reference field that isn't in this list.
 */
export const REFERENCE_FIELD_PRIORITY = [
  'image_url',
  'start_image_url',
  'input_image',
  'image',
  'reference_images',
  'reference_urls',
  'reference_image_urls',
  'image_urls',
  'image_input',
  'images',
] as const;

export interface ReferenceField {
  name: string;
  isArray: boolean;
  /** Extra body fields the declared slot pins (kling's `reference_type`). */
  also?: Record<string, string | number | boolean>;
}

/** Name-search fallback per media kind, for models that declare no `media`.
 *  Video and audio are their own short lists, for the same reason the app's
 *  model-router keeps them separate: a track or a clip is never a substitute
 *  for a frame, so a near-miss on a lookalike image field is worse than no
 *  match at all. `image_url` on a clip is exactly how an mp4 reached the
 *  provider as "content-type: video/mp4" — after the credit deduction.
 *
 *  Every name on the video list can only mean a source clip: `video_url` /
 *  `video` is how the video-edit/upscale family (video-upscaler,
 *  kling-video-edit, video-reframe, xai-video-edit, …) keys its input.
 *  Before they were listed, an explicit model override with a video_url was
 *  "proven" clip-less and substituted with seedance-2-reference — at 4x the
 *  credits of the upscaler the caller actually named. */
const FALLBACK_KEYS: Record<MediaKind, readonly string[]> = {
  image: REFERENCE_FIELD_PRIORITY,
  video: ['reference_videos', 'video_url', 'video'],
  audio: ['reference_audios', 'audio_url'],
};

/**
 * Which field this model wants a reference of `kind` in.
 *   - undefined → schema fetch failed; caller keeps its existing behavior.
 *   - null      → schema fetched, model has no slot for this kind.
 *   - {name}    → send the url as this key (wrapped in an array if the
 *                 schema types it as one), plus every `also` field.
 *
 * A DECLARED slot always wins: the field names lie, and only the declaration
 * knows it. `reference_urls` is images-only on grok-r2v and images-or-video
 * on wan-reference-to-video — identical name, identical derived shape,
 * opposite meaning — and kling's `start_image_url` (a still anchor) outranks
 * its real `video_url` in the search order, so a clip was filed as an image
 * reference pointing at an .mp4.
 *
 * Mirrors applySourceMedia / applySourceAudio in the app's
 * lib/agent/model-router.ts, including the asymmetry between them: a model
 * that declares `media` but no image/video slot for this kind gets NO name
 * search (the declaration is complete, a hit would be the wrong slot), while
 * audio keeps its search either way because every name on that list is a
 * genuine audio field — wan-2.7-video's `audio_url` is real and undeclared.
 */
export async function resolveMediaSlot(
  apiId: string,
  kind: MediaKind,
  client: PixelDojoClient,
): Promise<ReferenceField | null | undefined> {
  const info = await getModelInfo(apiId, client);
  if (info === null) return undefined;
  const declared = info.media?.[kind];
  if (declared) {
    return {
      name: declared.key,
      isArray: info.props[declared.key]?.type === 'array',
      also: declared.also,
    };
  }
  if (info.media && kind !== 'audio') return null;
  for (const name of FALLBACK_KEYS[kind]) {
    const field = info.props[name];
    if (field) return { name, isArray: field.type === 'array' };
  }
  return null;
}

/** "1080p" / "1080P" / "1080" are the same tier spelled three ways across
 *  tools (WAN r2v takes "720", Grok takes "720p"); 4k is 2160 lines. */
function resolutionHeight(value: string): number | null {
  const v = value.trim().toLowerCase();
  if (v === '4k') return 2160;
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) ? n : null;
}

/** Snap `resolution` to what the model declares. Same tri-state as the other
 *  snaps; matches across the p/no-p spelling difference, then falls back to
 *  the nearest declared tier by line count. */
export async function snapResolution(
  apiId: string,
  requested: string | undefined,
  client: PixelDojoClient,
  opts: SnapOptions = {},
): Promise<string | undefined> {
  if (!requested) return undefined;
  const props = await getFieldConstraints(apiId, client);
  if (props === null) {
    return opts.onUnknown === 'omit' ? undefined : requested; // fetch failed
  }
  const field = props.resolution;
  if (!field) return undefined; // confirmed: this model doesn't take resolution
  if (!field.enum || field.enum.length === 0) return requested; // unconstrained
  if (field.enum.includes(requested)) return requested;
  const target = resolutionHeight(requested);
  if (target === null) return requested;
  let best = requested;
  let bestDiff = Infinity;
  for (const candidate of field.enum) {
    const h = resolutionHeight(candidate);
    if (h === null) continue;
    const diff = Math.abs(h - target);
    if (diff < bestDiff) {
      bestDiff = diff;
      best = candidate;
    }
  }
  return best;
}

/** Snap `duration` (seconds) to the model's schema — nearest match for a
 *  discrete enum, clamp for a continuous min/max. Returns undefined when
 *  there's nothing to send (no value requested, or the model's schema
 *  confirms it doesn't take a `duration` field — e.g. the video-input
 *  tools that key length as `video_duration` instead). */
export async function snapDuration(
  apiId: string,
  requested: number | undefined,
  client: PixelDojoClient,
  opts: SnapOptions = {},
): Promise<number | undefined> {
  if (requested === undefined) return undefined;
  const props = await getFieldConstraints(apiId, client);
  if (props === null) {
    return opts.onUnknown === 'omit' ? undefined : requested; // fetch failed
  }
  const field = props.duration;
  if (!field) return undefined; // confirmed: this model doesn't take duration
  if (field.enum && field.enum.length > 0) {
    const allowed = field.enum.map(Number).filter((n) => Number.isFinite(n));
    if (allowed.length === 0) return requested;
    if (allowed.includes(requested)) return requested;
    return allowed.reduce((best, candidate) =>
      Math.abs(candidate - requested) < Math.abs(best - requested) ? candidate : best,
    );
  }
  if (typeof field.minimum === 'number' || typeof field.maximum === 'number') {
    let v = requested;
    if (typeof field.minimum === 'number') v = Math.max(field.minimum, v);
    if (typeof field.maximum === 'number') v = Math.min(field.maximum, v);
    return v;
  }
  return requested; // declared but unconstrained
}

/** A source url that's a clip rather than a still. Signed CDN urls carry
 *  query strings, so match on the extension only; an extensionless clip is
 *  why the skills take an explicit `video_url` input rather than sniffing
 *  everywhere. Same regex as isVideoUrl in the app's model-router.ts. */
export function isVideoUrl(url: string): boolean {
  return /\.(mp4|mov|webm|m4v)(?:[?#]|$)/i.test(url);
}

/** A source url that's an audio track — neither a frame nor a clip, and it
 *  must never ride into a reference-IMAGE field: the provider kills the job
 *  ("does not point to a valid image … content-type: audio/mpeg") after the
 *  credit deduction. Same regex as isAudioUrl in the app's model-router.ts. */
export function isAudioUrl(url: string): boolean {
  return /\.(mp3|wav|m4a|aac|ogg|flac)(?:[?#]|$)/i.test(url);
}

/** Parameter names a reference image can arrive under, most specific
 *  first. Mirrors EDIT_IMAGE_KEYS in the app's lib/agent/model-router.ts —
 *  the same list the in-app agent resolves against. */
const REF_KEYS = [
  'image_urls',
  'images',
  'image_input',
  'reference_images',
  'reference_urls',
  'image_url',
  'input_image',
  'image',
] as const;

export interface ResolvedImageRefs {
  /** Schema property to write the reference(s) into. */
  key: string;
  /** Array for array-typed params (clamped to the schema's maxItems),
   *  single URL for scalar ones. */
  value: string[] | string;
  /** URLs dropped to fit the model's cap, so the caller can tell the user. */
  dropped: number;
  /** Extra body fields a declared slot pins. */
  also?: Record<string, string | number | boolean>;
}

/**
 * Resolve WHERE a model wants its reference images, and how many it takes,
 * from its published schema.
 *
 * The previous hardcoded switch was wrong for half the allowlist: flux-edit
 * was sent `image_url` when its schema requires `input_image_1`, so EVERY
 * flux-edit edit failed; gpt-image-2-edit was sent `image_url` when it only
 * accepts `image_urls`, so single-image edits failed while 2-8 worked; and
 * nothing clamped to maxItems, so wan-2.6-image-edit 400'd at 5+ images and
 * gpt-image-2-edit at 9. Schemas strip unknown keys rather than rejecting
 * them, so a wrong key can also mean the reference is silently discarded
 * and the user is billed for a from-scratch image.
 *
 * Returns null when the schema fetch fails or the model declares no
 * reference field — the caller keeps its existing behavior rather than
 * guessing.
 */
export async function resolveImageRefs(
  apiId: string,
  urls: string[],
  client: PixelDojoClient,
): Promise<ResolvedImageRefs | null> {
  if (urls.length === 0) return null;
  const info = await getModelInfo(apiId, client);
  if (info === null) return null; // fetch failed — caller falls back

  // Declared image slot first (same rule as resolveMediaSlot); the REF_KEYS
  // search is the fallback for models that declare no `media`.
  const props = info.props;
  const key = info.media
    ? info.media.image?.key
    : REF_KEYS.find((k) => props[k] !== undefined);
  if (!key) return null; // model declares no reference field
  const also = info.media?.image?.also;
  const field = props[key] ?? {};

  if (field.type === 'array') {
    const cap = typeof field.maxItems === 'number' ? field.maxItems : urls.length;
    const kept = urls.slice(0, Math.max(1, cap));
    return { key, value: kept, dropped: urls.length - kept.length, also };
  }
  return { key, value: urls[0], dropped: urls.length - 1, also };
}
