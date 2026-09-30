/**
 * Registry of all named MCP skills shipped by `@pixeldojo/mcp`.
 *
 * Adding a new skill: drop a file in this directory exporting a
 * `SkillModule`, then append it to `ALL_SKILLS` here. The server reads
 * from this list to populate `tools/list` and route `tools/call`.
 */
import { generateSkill } from './generate.js';
import { editSkill } from './edit.js';
import { characterSkill } from './character.js';
import { storyboardSkill } from './storyboard.js';
import { upscaleSkill } from './upscale.js';
import { statusSkill } from './status.js';
import { fromUrlSkill } from './from-url.js';
import { filmSkill } from './film.js';
import { videoSkill } from './video.js';
import { episodeSkill } from './episode.js';
import { adSkill } from './ad.js';
import { campaignSkill } from './campaign.js';
import { campaignStatusSkill } from './campaign-status.js';
import { uploadSkill } from './upload.js';
import { audioSkill } from './audio.js';
import { librarySkill } from './library.js';
import {
  saveWorkflowSkill,
  runWorkflowSkill,
  listWorkflowsSkill,
} from './workflows.js';
import type { SkillModule } from './types.js';

export const ALL_SKILLS: ReadonlyArray<SkillModule<unknown>> = [
  generateSkill,
  editSkill,
  characterSkill,
  storyboardSkill,
  upscaleSkill,
  audioSkill,
  librarySkill,
  saveWorkflowSkill,
  runWorkflowSkill,
  listWorkflowsSkill,
  statusSkill,
  fromUrlSkill,
  uploadSkill,
  adSkill,
  campaignSkill,
  campaignStatusSkill,
  filmSkill,
  videoSkill,
  episodeSkill,
] as ReadonlyArray<SkillModule<unknown>>;

export {
  filmSkill,
  videoSkill,
  episodeSkill,
  generateSkill,
  editSkill,
  characterSkill,
  storyboardSkill,
  upscaleSkill,
  audioSkill,
  librarySkill,
  saveWorkflowSkill,
  runWorkflowSkill,
  listWorkflowsSkill,
  statusSkill,
  fromUrlSkill,
  uploadSkill,
  adSkill,
  campaignSkill,
  campaignStatusSkill,
};
export type { SkillModule, SkillContext, SkillResult } from './types.js';

/**
 * The skill set the hosted https://pixeldojo.ai/mcp route serves. The server
 * there runs in our production container, so "a local file" would be ITS
 * disk: pixeldojo_upload is dropped and every `*_path` / `*_paths` field is
 * stripped from the advertised schemas. uploadLocalFile also refuses unless
 * ctx.localFiles is true, which covers args that arrive anyway (a client
 * with a cached schema, a saved run_workflow step).
 */
const isLocalPathField = (key: string) => /_paths?$/.test(key);

export const HOSTED_SKILLS: ReadonlyArray<SkillModule<unknown>> = ALL_SKILLS.filter(
  (s) => s.name !== uploadSkill.name,
).map((s) => {
  const props = (s.inputJsonSchema.properties ?? {}) as Record<string, unknown>;
  return {
    ...s,
    description: s.hostedDescription ?? s.description,
    inputJsonSchema: {
      ...s.inputJsonSchema,
      properties: Object.fromEntries(Object.entries(props).filter(([k]) => !isLocalPathField(k))),
    },
  };
});

/**
 * MCP tool annotations for every skill. ChatGPT's plugin review rejects tools
 * without readOnlyHint / destructiveHint / openWorldHint, and clients use them
 * to decide when to ask before a call. Rationale per hint:
 * - readOnlyHint: false for anything that renders, spends credits or saves.
 * - destructiveHint: renders are additive (new media, nothing of the user's
 *   is changed or deleted; failed jobs refund), so false. save_workflow
 *   overwrites a same-named workflow, so true.
 * - openWorldHint: everything stays inside the user's own account, except
 *   from_url, which fetches an arbitrary public page.
 */
type Hints = { title: string; readOnlyHint: boolean; destructiveHint: boolean; openWorldHint: boolean };
const render = (title: string): Hints => ({ title, readOnlyHint: false, destructiveHint: false, openWorldHint: false });
const read = (title: string): Hints => ({ title, readOnlyHint: true, destructiveHint: false, openWorldHint: false });

export const TOOL_ANNOTATIONS: Record<string, Hints> = {
  pixeldojo_generate: render('Generate image or video'),
  pixeldojo_edit: render('Edit image'),
  pixeldojo_character: render('Consistent character image'),
  pixeldojo_storyboard: render('Storyboard preview video'),
  pixeldojo_upscale: render('Upscale image or video'),
  pixeldojo_audio: render('Generate music, speech or sound'),
  pixeldojo_video: render('Change, animate or extend video'),
  pixeldojo_ad: render('Make video ad'),
  pixeldojo_campaign: render('Make product launch campaign'),
  pixeldojo_film: render('Make short film'),
  pixeldojo_episode: render('Make faceless video'),
  pixeldojo_run_workflow: render('Run saved workflow'),
  pixeldojo_upload: render('Upload local file'),
  pixeldojo_save_workflow: { ...render('Save workflow'), destructiveHint: true },
  pixeldojo_status: read('Check job status'),
  pixeldojo_campaign_status: read('Check campaign status'),
  pixeldojo_library: read('Search media library'),
  pixeldojo_list_workflows: read('List saved workflows'),
  pixeldojo_from_url: { ...read('Read product page'), openWorldHint: true },
};

/** The tools/list entry for a skill, shared by the stdio server and the hosted /mcp route. */
export function toolListing(skill: SkillModule<unknown>) {
  const { title, ...hints } = TOOL_ANNOTATIONS[skill.name];
  return {
    name: skill.name,
    title,
    description: skill.description,
    inputSchema: skill.inputJsonSchema,
    annotations: { title, ...hints },
  };
}

export function findHostedSkill(name: string): SkillModule<unknown> | undefined {
  const wanted = name.replace(/^pixeldojo:/, 'pixeldojo_');
  return HOSTED_SKILLS.find((s) => s.name === wanted);
}

/**
 * Skill names were `pixeldojo:<x>` until 2026-07-29. A colon is illegal in a
 * tool name per Anthropic's `^[a-zA-Z0-9_-]{1,64}$`, so claude.ai's remote-MCP
 * connector rejected the whole tools array and every tool call in the
 * conversation failed (Claude Code silently sanitized, which hid it). Names are
 * underscored now; the old form still resolves for callers that memorized it
 * and for workflow steps saved under the colon names.
 */
export function findSkill(name: string): SkillModule<unknown> | undefined {
  const wanted = name.replace(/^pixeldojo:/, 'pixeldojo_');
  return ALL_SKILLS.find((s) => s.name === wanted);
}
