/**
 * pixeldojo_save_workflow / :run_workflow / :list_workflows — named, saved
 * skill chains ("describe a workflow once, run it by name from any chat").
 *
 * Definitions live server-side (/api/v1/workflows, per user). Execution
 * happens HERE: run_workflow fetches the definition and dispatches each
 * step to the local skill registry, so every step benefits from the same
 * polling, upload-bridge, and error handling as a direct skill call.
 *
 * Chaining placeholders inside step args (string values only):
 *   {{input.<key>}} → value from run_workflow's `inputs` object
 *   {{prev}}        → first asset URL produced by the previous step
 */
import { z } from 'zod';
import { pollJobUntilDoneOrHandoff } from '../poll.js';
import {
  type SkillContext,
  type SkillModule,
  type SkillResult,
  pollResultToSkillResult,
} from './types.js';

// Each step's own skill.run() already burns up to 30s (D9's sync window)
// before returning a handoff. A multi-step workflow's whole point is
// chaining outputs, so a step that's merely slow — not stuck — shouldn't
// silently break the chain. Poll for another 60s past that before giving
// up and reporting the step as still-processing.
const WORKFLOW_STEP_EXTRA_BUDGET_MS = 60_000;

const StepSchema = z.object({
  skill: z
    .string()
    // `pixeldojo:` accepted alongside `pixeldojo_` — workflows saved before the
    // 2026-07-29 rename still carry colon step names.
    .regex(/^pixeldojo[:_](generate|edit|character|storyboard|upscale|audio|upload|from_url)$/, {
      message:
        'Runnable skills only: generate, edit, character, storyboard, upscale, audio, upload, from_url.',
    }),
  args: z.record(z.string(), z.unknown()).optional(),
});

const SaveInputSchema = z.object({
  name: z
    .string()
    .regex(/^[a-z0-9][a-z0-9-]{1,40}$/, {
      message: 'Kebab-case, 2-41 chars, e.g. "product-launch-pack".',
    })
    .describe('Workflow handle. Saving to an existing name overwrites it.'),
  description: z.string().max(500).optional(),
  steps: z.array(StepSchema).min(1).max(8),
});
type SaveInput = z.infer<typeof SaveInputSchema>;

const RunInputSchema = z.object({
  name: z.string().describe('Saved workflow name.'),
  inputs: z
    .record(z.string(), z.string())
    .optional()
    .describe('Values for {{input.<key>}} placeholders in the workflow steps.'),
});
type RunInput = z.infer<typeof RunInputSchema>;

const ListInputSchema = z.object({});
type ListInput = z.infer<typeof ListInputSchema>;

/** Fill {{input.<key>}} and {{prev}} placeholders in string arg values. */
export function substitutePlaceholders(
  args: Record<string, unknown>,
  inputs: Record<string, string>,
  prevUrl: string | undefined,
): { resolved: Record<string, unknown>; missing: string[] } {
  const missing: string[] = [];
  const fill = (value: unknown): unknown => {
    if (typeof value === 'string') {
      return value.replace(/\{\{(prev|input\.[a-zA-Z0-9_-]+)\}\}/g, (_, token: string) => {
        if (token === 'prev') {
          if (!prevUrl) missing.push('{{prev}}');
          return prevUrl ?? '';
        }
        const key = token.slice('input.'.length);
        if (!(key in inputs)) missing.push(`{{${token}}}`);
        return inputs[key] ?? '';
      });
    }
    if (Array.isArray(value)) return value.map(fill);
    if (value && typeof value === 'object') {
      return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, fill(v)]));
    }
    return value;
  };
  return { resolved: fill(args) as Record<string, unknown>, missing };
}

/** Pull the first URL out of a skill result (assets or a URL in text). */
function firstUrl(result: SkillResult): string | undefined {
  if (result.kind === 'assets' && result.assetUrls.length > 0) return result.assetUrls[0];
  if (result.kind === 'text') {
    const m = result.text.match(/https?:\/\/\S+/);
    return m?.[0].replace(/[).,]+$/, '');
  }
  return undefined;
}

async function runSave(input: SaveInput, ctx: SkillContext): Promise<SkillResult> {
  const res = await ctx.client.saveWorkflow({
    name: input.name,
    description: input.description,
    steps: input.steps.map((s) => ({ skill: s.skill, args: s.args ?? {} })),
  });
  return {
    kind: 'text',
    text: res.created
      ? `Saved workflow "${res.name}" (${res.steps} step${res.steps === 1 ? '' : 's'}). Run it with pixeldojo_run_workflow { name: "${res.name}" }.`
      : `Overwrote workflow "${res.name}" (${res.steps} step${res.steps === 1 ? '' : 's'}).`,
  };
}

async function runList(_input: ListInput, ctx: SkillContext): Promise<SkillResult> {
  const res = await ctx.client.listWorkflows();
  if (res.count === 0) {
    return {
      kind: 'text',
      text: 'No saved workflows yet. Save one with pixeldojo_save_workflow { name, steps: [{ skill, args }] }.',
    };
  }
  const lines = res.workflows.map(
    (w) =>
      `- ${w.name} (${w.steps.length} steps, ${w.runs} runs)${w.description ? `: ${w.description}` : ''}`,
  );
  return { kind: 'text', text: `${res.count} saved workflow(s):\n${lines.join('\n')}` };
}

async function runWorkflow(input: RunInput, ctx: SkillContext): Promise<SkillResult> {
  const workflow = await ctx.client.getWorkflow(input.name.toLowerCase(), { countRun: true });

  // Late import to avoid a static cycle (index.ts imports this module).
  const { findSkill } = await import('./index.js');

  const inputs = input.inputs ?? {};
  const outputs: string[] = [];
  let prevUrl: string | undefined;

  for (let i = 0; i < workflow.steps.length; i++) {
    const step = workflow.steps[i];
    const skill = findSkill(step.skill);
    if (!skill) {
      return {
        kind: 'text',
        text: `Step ${i + 1} names unknown skill "${step.skill}". Re-save the workflow.`,
      };
    }
    const { resolved, missing } = substitutePlaceholders(step.args, inputs, prevUrl);
    if (missing.length > 0) {
      return {
        kind: 'text',
        text: `Step ${i + 1} (${step.skill}) is missing ${Array.from(new Set(missing)).join(', ')}. ${
          missing.some((m) => m.includes('input.'))
            ? 'Pass the value via run_workflow inputs.'
            : 'A previous step produced no asset URL.'
        }`,
      };
    }

    const parsed = skill.inputZod.safeParse(resolved);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      return {
        kind: 'text',
        text: `Step ${i + 1} (${step.skill}) has invalid args: ${issue?.path.join('.') || 'input'} ${issue?.message || 'invalid'}.`,
      };
    }

    let result = await skill.run(parsed.data, ctx);
    if (result.kind === 'handoff') {
      // The step's own 30s sync window wasn't enough — keep polling the
      // SAME job rather than treating "still running" as "produced
      // nothing" (that used to silently break any chain with a slow
      // intermediate step: firstUrl() had no case for 'handoff' at all).
      const handoffJobId = result.jobId;
      const polled = await pollJobUntilDoneOrHandoff(
        handoffJobId,
        (id) => ctx.client.getJob(id),
        ctx.buildStatusUrl,
        {
          syncBudgetMs: WORKFLOW_STEP_EXTRA_BUDGET_MS,
          now: ctx.pollOverrides?.now,
          sleep: ctx.pollOverrides?.sleep,
        },
      );
      result = pollResultToSkillResult(polled, (urls) =>
        urls.length === 0
          ? `Job ${handoffJobId} completed but returned no assets.`
          : `Done. Asset: ${urls[0]}`,
      );
    }
    const url = firstUrl(result);
    if (url) {
      prevUrl = url;
      outputs.push(`step ${i + 1} (${step.skill}): ${url}`);
    } else if (result.kind === 'text' && /fail|error|invalid|unknown/i.test(result.text)) {
      return {
        kind: 'text',
        text: `Workflow "${workflow.name}" stopped at step ${i + 1} (${step.skill}): ${result.text}`,
      };
    } else if (result.kind === 'handoff') {
      // Still running after the extended wait — stop the chain here (no
      // URL to feed the next step) but hand the caller everything needed
      // to follow up instead of a dead-end "no asset URL".
      return {
        kind: 'text',
        text:
          `Workflow "${workflow.name}" is still on step ${i + 1} (${step.skill}) after an extended wait. ` +
          `Poll with pixeldojo_status { jobId: "${result.jobId}" }, then re-run the workflow once it completes.`,
      };
    } else {
      outputs.push(`step ${i + 1} (${step.skill}): done (no asset URL)`);
    }
  }

  return {
    kind: 'text',
    text: `Workflow "${workflow.name}" completed ${workflow.steps.length} step(s):\n${outputs.join('\n')}`,
  };
}

/** Tools a workflow step may run; mirrors the StepSchema regex above. */
const STEP_SKILLS = [
  'pixeldojo_generate',
  'pixeldojo_edit',
  'pixeldojo_character',
  'pixeldojo_storyboard',
  'pixeldojo_upscale',
  'pixeldojo_audio',
  'pixeldojo_upload',
  'pixeldojo_from_url',
];

const stepJson = {
  type: 'object',
  properties: {
    skill: {
      type: 'string',
      enum: STEP_SKILLS,
      description:
        "Tool this step runs. Steps run in order when the workflow runs, and each is charged at that tool's own rate.",
    },
    args: {
      type: 'object',
      description:
        "That tool's own arguments, exactly as you would pass them calling it directly. Any string value, at any depth, may contain {{input.<key>}} (filled from pixeldojo_run_workflow inputs) or {{prev}} (the first asset URL the previous step produced).",
    },
  },
  required: ['skill'],
} as const;

export const saveWorkflowSkill: SkillModule<SaveInput> = {
  name: 'pixeldojo_save_workflow',
  description:
    'Save a named multi-step skill chain (generate → edit → upscale …). String args may contain {{input.<key>}} and {{prev}} placeholders. Saving to an existing name overwrites it.',
  inputZod: SaveInputSchema,
  inputJsonSchema: {
    type: 'object',
    properties: {
      name: {
        type: 'string',
        pattern: '^[a-z0-9][a-z0-9-]{1,40}$',
        description: 'Kebab-case handle, 2-41 chars (e.g. "product-launch-pack"). Saving to an existing name overwrites it.',
      },
      description: { type: 'string', description: 'Optional note on what the workflow does (max 500 chars).' },
      steps: {
        type: 'array',
        items: stepJson,
        minItems: 1,
        maxItems: 8,
        description: 'The chain, 1-8 steps, run in order. Saving charges nothing; running charges each step.',
      },
    },
    required: ['name', 'steps'],
  },
  allowedModels: [],
  defaultModel: '',
  run: runSave,
};

export const runWorkflowSkill: SkillModule<RunInput> = {
  name: 'pixeldojo_run_workflow',
  description:
    'Run a saved workflow by name. Pass inputs for its {{input.<key>}} placeholders; each step feeds the next via {{prev}}.',
  inputZod: RunInputSchema,
  inputJsonSchema: {
    type: 'object',
    properties: {
      name: { type: 'string', description: 'Saved workflow name (see pixeldojo_list_workflows).' },
      inputs: {
        type: 'object',
        additionalProperties: { type: 'string' },
        description:
          'String values for the workflow\'s {{input.<key>}} placeholders, e.g. {"product": "red sneaker"}. A step whose placeholder has no value stops the run before that step.',
      },
    },
    required: ['name'],
  },
  allowedModels: [],
  defaultModel: '',
  run: runWorkflow,
};

export const listWorkflowsSkill: SkillModule<ListInput> = {
  name: 'pixeldojo_list_workflows',
  description: 'List your saved workflows with step counts and run totals.',
  inputZod: ListInputSchema,
  inputJsonSchema: { type: 'object', properties: {}, required: [] },
  allowedModels: [],
  defaultModel: '',
  run: runList,
};
