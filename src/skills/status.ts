/**
 * pixeldojo_status — poll companion for the 30s sync handoff.
 *
 * Per CEO D9: when a job exceeds the synchronous wait budget, the calling
 * skill returns `{ jobId, statusUrl }` and the LLM follows up by calling
 * this tool with the same jobId. The skill polls once and surfaces the
 * current state — completed (with assets), failed (with error), or still
 * processing (with eta).
 */
import { z } from 'zod';
import {
  type SkillContext,
  type SkillModule,
  type SkillResult,
} from './types.js';

const InputSchema = z.object({
  jobId: z
    .string()
    .min(1)
    .max(200)
    .describe('Job id returned from a prior pixeldojo_* skill handoff.'),
});

type Input = z.infer<typeof InputSchema>;

const InputJsonSchema = {
  type: 'object',
  properties: {
    jobId: {
      type: 'string',
      description: 'The jobId a generation tool returned instead of an asset (a job_... id).',
    },
  },
  required: ['jobId'],
} as const;

/** Threshold (ms) past which we tell the agent the job is unusually slow. */
const STUCK_HINT_MS = 5 * 60 * 1000;
/** Threshold (ms) past which we tell the agent the job is almost certainly stuck. */
const ABANDON_HINT_MS = 12 * 60 * 1000;

async function run(input: Input, ctx: SkillContext): Promise<SkillResult> {
  const job = await ctx.client.getJob(input.jobId);

  if (job.status === 'completed') {
    const urls = extractAssetUrls(job);
    return {
      kind: 'assets',
      text:
        urls.length === 0
          ? `Job ${input.jobId} completed but returned no assets.`
          : urls.length === 1
            ? `Job ${input.jobId} completed. Asset: ${urls[0]}`
            : `Job ${input.jobId} completed. Assets: ${urls.join(', ')}`,
      assetUrls: urls,
    };
  }

  if (job.status === 'failed') {
    const errMsg =
      typeof job.error === 'string'
        ? job.error
        : (job.error as { message?: string } | undefined)?.message ?? 'Unknown provider error';
    return {
      kind: 'text',
      text: `Job ${input.jobId} failed: ${errMsg}`,
    };
  }

  // Pending or processing — surface job age + a hint when the wait is
  // unusually long, so the agent stops blindly polling forever.
  const apiId = (job as { apiId?: string }).apiId ?? 'unknown';
  const ageMs = jobAgeMs(job);
  const ageLabel = formatAge(ageMs);

  let hint: string;
  if (ageMs >= ABANDON_HINT_MS) {
    hint =
      `That's well past the typical generation window for any model on PixelDojo. ` +
      `The job is almost certainly stuck. Submit a fresh request, or open ${ctx.buildStatusUrl(input.jobId)} for the raw record.`;
  } else if (ageMs >= STUCK_HINT_MS) {
    hint =
      `That's longer than most generations should take. ` +
      `Poll once more, or submit a fresh request if the next check still says ${job.status}.`;
  } else {
    hint = `Try again in a few seconds, or follow ${ctx.buildStatusUrl(input.jobId)}.`;
  }

  return {
    kind: 'handoff',
    text:
      `Job ${input.jobId} (${apiId}) is ${job.status} after ${ageLabel}. ${hint}`,
    jobId: input.jobId,
    statusUrl: ctx.buildStatusUrl(input.jobId),
  };
}

function jobAgeMs(job: unknown): number {
  const createdAt = (job as { createdAt?: string }).createdAt;
  if (!createdAt) return 0;
  const t = Date.parse(createdAt);
  if (Number.isNaN(t)) return 0;
  const age = Date.now() - t;
  return age >= 0 ? age : 0;
}

function formatAge(ms: number): string {
  if (ms < 60_000) return `${Math.max(1, Math.round(ms / 1000))}s`;
  const totalSeconds = Math.round(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes < 60) {
    return seconds === 0 ? `${minutes}m` : `${minutes}m ${seconds}s`;
  }
  const hours = Math.floor(minutes / 60);
  const remMinutes = minutes % 60;
  return remMinutes === 0 ? `${hours}h` : `${hours}h ${remMinutes}m`;
}

function extractAssetUrls(job: {
  assets?: Array<{ url: string }>;
  output?: unknown;
}): string[] {
  if (job.assets && job.assets.length > 0) return job.assets.map((a) => a.url);
  const output = job.output as
    | { images?: string[]; videos?: string[]; image?: string; video?: string }
    | undefined;
  if (output?.images) return output.images;
  if (output?.videos) return output.videos;
  if (output?.image) return [output.image];
  if (output?.video) return [output.video];
  return [];
}

export const statusSkill: SkillModule<Input> = {
  name: 'pixeldojo_status',
  description:
    'Check once, without waiting, on a jobId that a generation tool returned instead of an asset after its 30s wait. Free. Returns asset URLs when complete, the failure reason if it failed, or the current state and job age if still running. Campaign ids go to pixeldojo_campaign_status; films report progress through pixeldojo_film with action "status".',
  inputZod: InputSchema,
  inputJsonSchema: InputJsonSchema,
  // status is special — it doesn't dispatch to a model
  allowedModels: [],
  defaultModel: '',
  run,
};
