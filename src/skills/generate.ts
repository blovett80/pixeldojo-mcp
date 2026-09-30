/**
 * pixeldojo_generate — generic image/video generation skill.
 *
 * Default routing: text-to-image via `seedream-5` (best quality, fewest
 * provider refusals). Users can override by passing a `model` field; any apiId
 * that exists in the registry is accepted (allowedModels: null).
 */
import { z } from 'zod';
import { pollJobUntilDoneOrHandoff } from '../poll.js';
import {
  type SkillContext,
  type SkillModule,
  type SkillResult,
  pollResultToSkillResult,
} from './types.js';
import { SkillUploadError, uploadLocalFile } from './upload-helpers.js';
import {
  type ReferenceField,
  isAudioUrl,
  isVideoUrl,
  resolveMediaSlot,
  snapAspectRatio,
  snapDuration,
  snapResolution,
} from './schema-snap.js';
import {
  PARAMS_JSON_SCHEMA,
  ParamsInput,
  applyParams,
  paramsWithoutModel,
  prefixNote,
} from './params.js';

/** Seedance 2.5 draft mode. Mirrors app/(dashboard)/(routes)/seedance-2-5
 *  constants; tests/contracts/mcp-seedance-draft-parity.test.ts pins them. */
export const DRAFT_MODEL = 'seedance-2-5';
export const DRAFT_RESOLUTION = '480p';
export const DRAFT_FINAL_RESOLUTION = '1080p';
export const DRAFT_DEFAULT_DURATION = 5;
const DRAFT_DESCRIPTION =
  'Seedance 2.5 draft mode: render a cheap 480p draft (runs on seedance-2-5) so the user can try takes before paying for full resolution. The reply gives the draft\'s job id and duration; pass them to upgrade_draft to render that exact take at 1080p.';
const UPGRADE_DESCRIPTION =
  'Job id of a finished Seedance 2.5 draft to render at 1080p, the same take with full detail. Also pass `duration` equal to the draft\'s (the draft reply states it). The draft\'s prompt and media are reused, so prompt and references are ignored. Billed as a 1080p run.';

const InputSchema = z.object({
  prompt: z.string().min(1).max(8000).describe('Prompt describing what to generate.'),
  model: z
    .string()
    .optional()
    .describe(
      'Model apiId. Recommended (the models the PixelDojo studios use): "seedream-5" for images (the default), "seedance-2-5" for video (prompt only or a starting image), "wan-3-0-video" for video the others refuse. Use another model only when the user names one. Full catalog: https://pixeldojo.ai/api/v1/models; one model\'s fields: https://pixeldojo.ai/llm/{apiId}.txt. Omit for seedream-5, which makes still images only; name a video model to get a video.',
    ),
  preset: z
    .string()
    .optional()
    .describe(
      'Preset slug that seeds the running model\'s settings; explicit fields and params override it. Each preset belongs to one model (browse them by model at https://pixeldojo.ai/presets), so set `model` to that preset\'s model: a slug the running model has no preset for is rejected with a 400 before any charge.',
    ),
  aspect_ratio: z
    .string()
    .optional()
    .describe('e.g. "1:1", "16:9", "9:16". Snapped to the nearest ratio the model supports, and dropped if the model has no aspect_ratio field.'),
  duration: z
    .number()
    .int()
    .positive()
    .optional()
    .describe('Video length in seconds. Snapped or clamped to what the model allows, and dropped if the model has no duration field. Required for grok-video-extend (the extension length).'),
  resolution: z
    .string()
    .optional()
    .describe(
      'Output resolution when the model supports it (e.g. "480p", "720p", "1080p", "4k"). Lower tiers cost fewer credits. Omit to use the model default.',
    ),
  image_url: z
    .string()
    .url()
    .optional()
    .describe('Reference still for image-to-image / image-to-video. A clip URL (.mp4/.mov/.webm) or an audio track URL (.mp3/.wav/.m4a/...) here is detected by extension and routed as that kind of media instead.'),
  video_url: z
    .string()
    .url()
    .optional()
    .describe(
      'Source video clip to animate / restyle / extend. Use this for videos; image_url is for still frames. With no model, a clip runs on seedance-2-reference; a named model with no clip input is swapped for it and the result says so.',
    ),
  params: ParamsInput,
  draft: z
    .boolean()
    .optional()
    .describe(DRAFT_DESCRIPTION),
  upgrade_draft: z
    .string()
    .regex(/^[A-Za-z0-9_-]{1,128}$/)
    .optional()
    .describe(UPGRADE_DESCRIPTION),
  image_path: z
    .string()
    .min(1)
    .optional()
    .describe(
      'Absolute local file path to a reference image/video. The skill uploads it to PixelDojo first (24h temp storage) and then dispatches. Prefer this over image_url when the user has the file on disk.',
    ),
  image_urls: z
    .array(z.string().url())
    .optional()
    .describe(
      'Multiple reference image URLs, for models that accept a reference set (character + wardrobe + location, for example). Models that take only one reference use the first and the rest are ignored.',
    ),
  image_paths: z
    .array(z.string().min(1))
    .optional()
    .describe(
      'Multiple absolute local file paths. Each is uploaded to PixelDojo (24h temp storage) and used as a reference, same rules as image_urls.',
    ),
});

type Input = z.infer<typeof InputSchema>;

// House default for stills (see AGENT_PREFERRED in lib/agent/roster.ts).
const DEFAULT_MODEL = 'seedream-5';

/** The one engine on the catalog that reads a video OR an audio reference.
 *  Every no-model clip/track path lands here, same as the in-app agent's
 *  VIDEO_REFERENCE_APIID. */
export const VIDEO_REFERENCE_MODEL = 'seedance-2-reference';

/** Its slots, statically. Only consulted when the schema fetch FAILED: this
 *  is the model we substituted TO precisely so a clip lands somewhere honest,
 *  and falling back to `image_url` there would reintroduce the exact provider
 *  rejection ("content-type: video/mp4") the substitution exists to prevent.
 *  Contract-tested against the real config by the app's
 *  tests/contracts/media-declarations.test.ts. */
const VIDEO_REFERENCE_SLOTS: Record<'image' | 'video' | 'audio', ReferenceField> = {
  image: { name: 'reference_images', isArray: true },
  video: { name: 'reference_videos', isArray: true },
  audio: { name: 'reference_audios', isArray: true },
};

function fallbackSlot(
  apiId: string,
  kind: 'image' | 'video' | 'audio',
): ReferenceField | undefined {
  return apiId === VIDEO_REFERENCE_MODEL ? VIDEO_REFERENCE_SLOTS[kind] : undefined;
}

// These three key length as `video_duration`, not `duration` — buildPayload
// below already remaps for them. Schema-snapping against the literal name
// "duration" would find nothing declared and drop the value the
// grok-video-extend required-field check just confirmed was present, so
// skip the generic snap for this set and trust the caller's value as-is.
const VIDEO_INPUT_MODELS = new Set(['grok-video-extend', 'wan-video-edit', 'seedance-video-edit']);

const InputJsonSchema = {
  type: 'object',
  properties: {
    prompt: { type: 'string', description: 'Prompt describing what to generate.' },
    model: {
      type: 'string',
      description:
        'Model apiId. Recommended (the models the PixelDojo studios use): "seedream-5" for images (the default), "seedance-2-5" for video (prompt only or a starting image), "wan-3-0-video" for video the others refuse. Use another model only when the user names one. Full catalog: https://pixeldojo.ai/api/v1/models; one model\'s fields: https://pixeldojo.ai/llm/{apiId}.txt. Omit for seedream-5, which makes still images only; name a video model to get a video.',
    },
    preset: {
      type: 'string',
      description:
        'Preset slug that seeds the running model\'s settings; explicit fields and params override it. Each preset belongs to one model (browse them by model at https://pixeldojo.ai/presets), so set `model` to that preset\'s model: a slug the running model has no preset for is rejected with a 400 before any charge.',
    },
    aspect_ratio: {
      type: 'string',
      description:
        'e.g. "1:1", "16:9", "9:16". Snapped to the nearest ratio the model supports, and dropped if the model has no aspect_ratio field.',
    },
    duration: {
      type: 'integer',
      description:
        'Video length in seconds. Snapped or clamped to what the model allows, and dropped if the model has no duration field. Required for grok-video-extend (the extension length).',
    },
    resolution: {
      type: 'string',
      description:
        'Output resolution when the model supports it (e.g. "480p", "720p", "1080p", "4k"). Snapped to the nearest tier the model offers, and dropped if the model has no resolution field. Lower tiers cost fewer credits.',
    },
    image_url: {
      type: 'string',
      format: 'uri',
      description:
        'Reference still for image-to-image / image-to-video. A clip URL (.mp4/.mov/.webm) or an audio track URL (.mp3/.wav/.m4a/...) here is detected by extension and routed as that kind of media instead.',
    },
    video_url: {
      type: 'string',
      format: 'uri',
      description:
        'Source video clip to animate / restyle / extend. Use this for videos; image_url is for still frames. With no model, a clip runs on seedance-2-reference; a named model with no clip input is swapped for it and the result says so.',
    },
    params: PARAMS_JSON_SCHEMA,
    draft: { type: 'boolean', description: DRAFT_DESCRIPTION },
    upgrade_draft: { type: 'string', description: UPGRADE_DESCRIPTION },
    image_urls: {
      type: 'array',
      items: { type: 'string', format: 'uri' },
      description:
        'Multiple reference image URLs for models that accept a reference set (character + wardrobe + location, for example). Single-reference models use the first and ignore the rest.',
    },
    image_paths: {
      type: 'array',
      items: { type: 'string' },
      description:
        'Multiple absolute local file paths (JPEG, PNG, WebP, GIF, MP4, WebM, MOV), each uploaded to 24h temp storage and used as a reference, same rules as image_urls.',
    },
    image_path: {
      type: 'string',
      description:
        'Absolute local file path to a reference image or clip (JPEG, PNG, WebP, GIF, MP4, WebM, MOV; no audio). The skill uploads it to 24h temp storage and uses the URL as image_url. Ignored when image_url is also set.',
    },
  },
  required: ['prompt'],
} as const;

/** What the caller actually handed us, split by media kind. Mirrors
 *  sourceMedia() in the app's lib/agent/skills.ts.
 *
 *  `video_url` is the explicit clip slot: an extension is all `isVideoUrl`
 *  has to go on, so a signed or extensionless CDN link to an mp4 read as a
 *  still and routed to a stills-only engine. A clip dropped into `image_url`
 *  (every pre-video_url caller, and the habit of most LLMs) is still caught
 *  by the extension check.
 *
 *  Audio is NEITHER a frame nor a clip and must never ride into a reference-
 *  image field, so it is split out here rather than left in the stills bag. */
interface SourceMedia {
  /** The single source frame or clip, if any. */
  url?: string;
  isClip: boolean;
  audioUrl?: string;
  /** Every still reference, in order, for models with an array slot. */
  stills: string[];
}

function sourceMedia(videoUrl: string | undefined, referenceUrls: string[]): SourceMedia {
  const clip = videoUrl && !isAudioUrl(videoUrl) ? videoUrl : undefined;
  const stills = referenceUrls.filter((u) => !isAudioUrl(u));
  const url = clip ?? stills[0];
  return {
    url,
    isClip: Boolean(clip) || (!!url && isVideoUrl(url)),
    audioUrl: [videoUrl, ...referenceUrls].find((u) => u && isAudioUrl(u)),
    stills,
  };
}

/**
 * Per-model param adapter. Agents only ever give us a generic
 * { image_url, video_url, duration, resolution }; each model declares its own
 * field names and schemas strip unknown keys, so a verbatim `image_url` is
 * silently dropped and the model then 400s naming a field the agent had no
 * way to set — an unrecoverable loop. `slot` is resolved from the model's
 * declared `media` block, falling back to its REAL schema (see
 * resolveMediaSlot), which is how the reference-driven video engines —
 * seedance-2-reference (reference_images / reference_videos /
 * reference_audios), grok-r2v / wan-reference-to-video / happyhorse-1.0-r2v
 * (reference_urls), kling-reference-to-video (start_image_url, or video_url
 * + reference_type='video' for a clip) — become reachable without a
 * per-model switch here.
 *
 * The video-edit / video-extend tools stay explicit: they also remap
 * duration → video_duration, which no schema lookup can infer.
 */
function buildPayload(
  apiId: string,
  input: Input,
  src: SourceMedia,
  slot: ReferenceField | null | undefined,
  audioSlot: ReferenceField | null | undefined,
): { prompt: string; [key: string]: unknown } {
  const body: { prompt: string; [key: string]: unknown } = { prompt: input.prompt };
  if (input.aspect_ratio) body.aspect_ratio = input.aspect_ratio;
  if (input.preset) body.preset = input.preset;

  switch (apiId) {
    case 'grok-video-extend':
    case 'wan-video-edit':
    case 'seedance-video-edit':
      // Video-input tools expect video_url / video_duration. Pass both shapes
      // so we work even if a model's schema later accepts the image_url alias.
      if (src.url) {
        body.video_url = src.url;
        body.image_url = src.url;
      }
      if (input.duration !== undefined) {
        body.video_duration = input.duration;
        body.duration = input.duration;
      }
      break;
    default:
      if (src.url) {
        // slot undefined (schema fetch failed) or null (model declares no
        // slot for this kind) → send image_url, i.e. exactly what we sent
        // before this adapter existed. No new failure mode on an unknown
        // schema. An array field takes every reference the caller gave; a
        // scalar takes the first, because there is nowhere honest to put the
        // rest — and a clip is one thing, so it never brings the stills bag.
        const refs = src.isClip ? [src.url] : src.stills.length > 0 ? src.stills : [src.url];
        if (slot) {
          body[slot.name] = slot.isArray ? refs : refs[0];
          // `also` is the part no key-name search could find: kling's
          // reference_type='video' is what selects the provider's clip
          // endpoint, so the url alone lands on the still path.
          if (slot.also) Object.assign(body, slot.also);
        } else {
          body.image_url = refs[0];
        }
      }
      // A track only ever goes in a declared audio slot. No fallback: a model
      // with none must DROP it rather than fall through to image_url, which
      // is exactly how an mp3 reached the provider as "content-type:
      // audio/mpeg" — after the credit deduction.
      if (src.audioUrl && audioSlot) {
        body[audioSlot.name] = audioSlot.isArray ? [src.audioUrl] : src.audioUrl;
        if (audioSlot.also) Object.assign(body, audioSlot.also);
      }
      if (input.duration !== undefined) body.duration = input.duration;
      if (input.resolution) body.resolution = input.resolution;
      break;
  }

  return body;
}

async function run(input: Input, ctx: SkillContext): Promise<SkillResult> {
  // Ask rather than guess: the same key means different things on different
  // models, so settings with nobody to attach them to are refused, not
  // applied to whatever the skill would have picked.
  const paramsGate = paramsWithoutModel(input.params, input.model);
  if (paramsGate) return { kind: 'text', text: paramsGate };

  if (input.upgrade_draft) return upgradeDraft(input, ctx);
  if (input.draft && input.model && input.model !== DRAFT_MODEL) {
    return {
      kind: 'text',
      text: `Draft mode runs on ${DRAFT_MODEL} only. Drop model (or set it to ${DRAFT_MODEL}) to render a 480p draft.`,
    };
  }
  if (input.draft) input = { ...input, model: DRAFT_MODEL, resolution: DRAFT_RESOLUTION };

  // If the caller passed a local file path, upload it first and treat the
  // resulting URL as image_url for the rest of the dispatch. Explicit
  // image_url wins if both are set (path is for "I only have a file").
  let resolved: Input = input;
  // Every reference the caller gave us, in order, singular first. Local paths
  // upload to 24h temp storage and join the list as URLs. image_url stays the
  // head of the list so single-reference models keep their old behaviour.
  let referenceUrls: string[] = [];
  try {
    const singleUrl =
      input.image_url ?? (input.image_path ? await uploadLocalFile(input.image_path, ctx) : undefined);
    const manyUrls = [...(input.image_urls ?? [])];
    for (const p of input.image_paths ?? []) {
      manyUrls.push(await uploadLocalFile(p, ctx));
    }
    referenceUrls = [...(singleUrl ? [singleUrl] : []), ...manyUrls].filter(
      (u, i, all) => all.indexOf(u) === i,
    );
    if (referenceUrls[0] && referenceUrls[0] !== input.image_url) {
      resolved = { ...input, image_url: referenceUrls[0] };
    }
  } catch (err) {
    if (err instanceof SkillUploadError) {
      return { kind: 'text', text: `pixeldojo_generate (upload): ${err.userMessage}` };
    }
    throw err;
  }

  const src = sourceMedia(input.video_url, referenceUrls);

  // Route the source to a model that can actually read it. A clip or a track
  // with no model named can only go to the one engine that takes either —
  // the same pick the in-app agent makes. A NAMED model gets the same
  // treatment when we can PROVE it has no clip slot: nothing downstream would
  // catch it (an image-to-video capability check is satisfied by every
  // stills-only i2v model), so the mp4 went out as a reference IMAGE and the
  // provider killed the job. Substitute and say so, rather than dead-end.
  //
  // `=== null` and not `!slot` on purpose: undefined means the schema fetch
  // failed, and substituting on a network blip would swap the caller's model
  // AND print a note claiming it can't do something it can.
  let apiId = input.model ?? DEFAULT_MODEL;
  let routeNote: string | undefined;
  if ((src.isClip || src.audioUrl) && !VIDEO_INPUT_MODELS.has(apiId)) {
    if (!input.model) {
      apiId = VIDEO_REFERENCE_MODEL;
    } else if (
      src.isClip &&
      (await resolveMediaSlot(input.model, 'video', ctx.client)) === null
    ) {
      apiId = VIDEO_REFERENCE_MODEL;
      routeNote = `${input.model} can't work from a video clip, so I used ${VIDEO_REFERENCE_MODEL} instead.`;
    }
  }

  // Required-field validation for video-extend (the only model with hard
  // per-call requirements above prompt). Without this the request reaches
  // the backend and returns `video_url: Required, video_duration: Required`,
  // which loops agents that don't know to retry with different keys.
  if (apiId === 'grok-video-extend') {
    if (!src.url) {
      return {
        kind: 'text',
        text:
          'pixeldojo_generate with model="grok-video-extend" requires video_url ' +
          '(the source video URL to extend, or image_path for a local file).',
      };
    }
    if (resolved.duration === undefined) {
      return {
        kind: 'text',
        text:
          'pixeldojo_generate with model="grok-video-extend" requires duration ' +
          '(extension length in seconds).',
      };
    }
  }

  let refField: ReferenceField | null | undefined;
  let audioSlot: ReferenceField | null | undefined;
  if (!VIDEO_INPUT_MODELS.has(apiId)) {
    // One schema fetch, shared by all five lookups (schema-snap caches the
    // in-flight promise per apiId).
    const [aspect_ratio, duration, resolution, ref, audio] = await Promise.all([
      snapAspectRatio(apiId, resolved.aspect_ratio, ctx.client),
      snapDuration(apiId, resolved.duration, ctx.client),
      snapResolution(apiId, resolved.resolution, ctx.client),
      src.url
        ? resolveMediaSlot(apiId, src.isClip ? 'video' : 'image', ctx.client)
        : Promise.resolve(undefined),
      src.audioUrl ? resolveMediaSlot(apiId, 'audio', ctx.client) : Promise.resolve(undefined),
    ]);
    resolved = { ...resolved, aspect_ratio, duration, resolution };
    // The engine every no-model clip/track routes to has static slots, so a
    // schema-fetch outage still files a clip under reference_videos instead
    // of image_url — which the provider rejects after the credit deduction.
    // Only `undefined` (fetch failed) falls back: a fetched `null` is a real
    // answer and must stay one.
    refField = ref === undefined && src.url ? fallbackSlot(apiId, src.isClip ? 'video' : 'image') : ref;
    audioSlot = audio === undefined && src.audioUrl ? fallbackSlot(apiId, 'audio') : audio;
  }

  const body = buildPayload(apiId, resolved, src, refField, audioSlot);
  const paramsNote = applyParams(body, input.params, input.model, apiId);
  // A draft states its exact duration: the upgrade must repeat it.
  const draftDuration = input.draft ? Number(body.duration ?? DRAFT_DEFAULT_DURATION) : undefined;
  if (input.draft) Object.assign(body, { draft: true, resolution: DRAFT_RESOLUTION, duration: draftDuration });
  const note = [routeNote, paramsNote].filter(Boolean).join(' ');

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

  const out = prefixNote(
    pollResultToSkillResult(result, (urls) =>
      urls.length === 0
        ? `Job ${submitted.jobId} completed but returned no assets.`
        : urls.length === 1
          ? `Generated. Asset: ${urls[0]}`
          : `Generated ${urls.length} assets. URLs: ${urls.join(', ')}`,
    ),
    note,
  );
  return draftDuration === undefined ? out : { ...out, text: `${out.text}\n\n${draftLine(submitted.jobId, draftDuration)}` };
}

/** Tells the caller (and, replayed, the in-app agent) exactly how to upgrade. */
export function draftLine(jobId: string, duration: number): string {
  return `This is a 480p draft (draft_job_id: ${jobId}, duration: ${duration}). When the user likes it, call pixeldojo_generate with {"upgrade_draft": "${jobId}", "duration": ${duration}} to render the same take at ${DRAFT_FINAL_RESOLUTION} (billed as a ${DRAFT_FINAL_RESOLUTION} run; upgrade it within a day).`;
}

/** Render a finished draft's exact take at 1080p. The provider reuses the
 *  draft's prompt and media and rejects an upgrade that resends them, so the
 *  body is only the draft id, the final resolution and the draft's duration. */
async function upgradeDraft(input: Input, ctx: SkillContext): Promise<SkillResult> {
  if (input.duration === undefined) {
    return {
      kind: 'text',
      text: `upgrade_draft also needs duration: the draft's own length (its reply says "duration: N"; ${DRAFT_DEFAULT_DURATION} when it was made without one).`,
    };
  }
  const submitted = await ctx.client.run(DRAFT_MODEL, {
    draft_job_id: input.upgrade_draft,
    resolution: DRAFT_FINAL_RESOLUTION,
    duration: input.duration,
  } as never);
  const result = await pollJobUntilDoneOrHandoff(submitted.jobId, (id) => ctx.client.getJob(id), ctx.buildStatusUrl, {
    now: ctx.pollOverrides?.now,
    sleep: ctx.pollOverrides?.sleep,
  });
  return prefixNote(
    pollResultToSkillResult(result, (urls) =>
      urls.length === 0 ? `Job ${submitted.jobId} completed but returned no assets.` : `Upgraded to ${DRAFT_FINAL_RESOLUTION}. Asset: ${urls[0]}`,
    ),
    `Rendering draft ${input.upgrade_draft} at ${DRAFT_FINAL_RESOLUTION}.`,
  );
}

export const generateSkill: SkillModule<Input> = {
  name: 'pixeldojo_generate',
  description:
    'Generate an image or video from a prompt with any model in the PixelDojo catalog. With no `model`, a prompt runs on seedream-5, which makes still images only. For a video, name seedance-2-5, which works from a prompt alone or a starting image. To try video takes cheaply, set draft: true (a 480p Seedance 2.5 draft), then upgrade_draft the one the user picks to 1080p. If a provider refuses the content, retry once on wan-3-0-video (video) or seedream-5 (images), the least-restricted models. For a multi-shot film or a music video synced to a song use pixeldojo_film; to change, move or extend an existing clip use pixeldojo_video. These are the models the PixelDojo studios use; name another only when the user asks for it. References: `image_url`/`image_urls` for stills, `video_url` for a source clip, `image_path`/`image_paths` for absolute local files (uploaded to 24h temp storage first). A clip or an audio track URL with no `model` runs on seedance-2-reference; a named model that cannot read a clip is swapped for it and the result says so, while a named model with no audio input drops the track. Model-specific settings go in `params` alongside an explicit `model`. Returns asset URLs, or a jobId for pixeldojo_status when the job outlasts the 30s wait.',
  hostedDescription:
    'Generate an image or video from a prompt with any model in the PixelDojo catalog. With no `model`, a prompt runs on seedream-5, which makes still images only. For a video, name seedance-2-5, which works from a prompt alone or a starting image. To try video takes cheaply, set draft: true (a 480p Seedance 2.5 draft), then upgrade_draft the one the user picks to 1080p. If a provider refuses the content, retry once on wan-3-0-video (video) or seedream-5 (images), the least-restricted models. For a multi-shot film or a music video synced to a song use pixeldojo_film; to change, move or extend an existing clip use pixeldojo_video. These are the models the PixelDojo studios use; name another only when the user asks for it. References: `image_url`/`image_urls` for stills and `video_url` for a source clip, all public http(s) URLs. A clip or an audio track URL with no `model` runs on seedance-2-reference; a named model that cannot read a clip is swapped for it and the result says so, while a named model with no audio input drops the track. Model-specific settings go in `params` alongside an explicit `model`. Returns asset URLs, or a jobId for pixeldojo_status when the job outlasts the 30s wait.',
  inputZod: InputSchema,
  inputJsonSchema: InputJsonSchema,
  allowedModels: null,
  defaultModel: DEFAULT_MODEL,
  run,
};
