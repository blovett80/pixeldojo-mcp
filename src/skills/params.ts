/**
 * Model-specific `params` passthrough — the MCP twin of `applyParams` in the
 * app's lib/agent/skills.ts.
 *
 * Deliberately an open record. Each model documents its own inputs and there
 * are 100+ of them, so enumerating those fields in a tool description is not
 * an option — but the model's OWN schema already is a validator, and
 * /api/v1/models/{apiId}/run runs it before a single credit is deducted. A
 * wrong field comes back named, with its allowed values, and the calling
 * agent corrects it on the next call. The validation loop is the
 * documentation, which is why nothing here inspects or rewrites the values:
 * a 400 the caller can act on beats a guess we made on its behalf.
 */
import { z } from 'zod';
import type { SkillResult } from './types.js';

export const ParamsInput = z.record(z.unknown()).optional();

export const PARAMS_JSON_SCHEMA: Record<string, unknown> = {
  type: 'object',
  additionalProperties: true,
  description:
    'Advanced settings for the model that runs this, named exactly as that model documents them (e.g. {"resolution": "1080p", "seed": 42}). Set `model` in the same call: field names differ per model, so params without one are refused. Applied last, so these override anything derived from the other inputs. An invalid field comes back named with its allowed values and nothing is charged, so fix it and call again.',
};

/** Refusal text when settings arrived with no model to attach them to, else
 *  null. Ask rather than guess: the same key means different things on
 *  different models, and the skill's own default is not what the caller had
 *  in mind when they wrote them. */
export function paramsWithoutModel(
  params: Record<string, unknown> | undefined,
  model: string | undefined,
): string | null {
  if (!params || Object.keys(params).length === 0) return null;
  if (model) return null;
  return 'Those settings are model-specific. Tell me which model to use and I will apply them.';
}

/** Overlay `params` onto a built body, LAST, so an explicit setting beats
 *  anything the skill derived. Returns a note to prepend to the result when
 *  we did not apply them verbatim.
 *
 *  Two carve-outs, both matching the in-app agent:
 *   - A SUBSTITUTED model gets nothing. `paramsModel` is the model those
 *     fields were written for; when routing sent the job elsewhere (the clip
 *     engine) the keys mean something else on the model that actually ran, or
 *     nothing at all. Dropping them keeps the generation alive and the note
 *     names the model to ask for.
 *   - `prompt` never rides in here. Every skill already takes one, and
 *     storyboard wraps it (brief → prompt), so an override would silently
 *     discard the caller's own text. */
export function applyParams(
  body: Record<string, unknown>,
  params: Record<string, unknown> | undefined,
  paramsModel: string | undefined,
  apiId: string,
): string | undefined {
  if (!params || Object.keys(params).length === 0) return undefined;
  if (paramsModel !== apiId) {
    return `This ran on ${apiId}, so I left those settings off: they are ${paramsModel}'s fields. Ask again naming ${apiId} if you want them applied.`;
  }
  const rest = { ...params };
  delete rest.prompt;
  Object.assign(body, rest);
  return 'prompt' in params
    ? 'I kept the prompt from the skill call and ignored the one in params.'
    : undefined;
}

/** Ride a routing/params note out on whatever the job returns — success,
 *  handoff, or failure — so the caller never sees a result from a model it
 *  never named with no explanation. */
export function prefixNote(result: SkillResult, note: string | undefined): SkillResult {
  if (!note) return result;
  return { ...result, text: `${note} ${result.text}`.trim() };
}
