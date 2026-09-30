/**
 * pixeldojo_campaign_status — poll companion for a long-running campaign.
 *
 * Same conceptual role as pixeldojo_status (which is per-job), but at the
 * campaign envelope level: returns either the full asset list when every
 * sub-job is terminal, or a handoff with the still-running sub-jobs.
 */
import { z } from 'zod';
import {
  type SkillContext,
  type SkillModule,
  type SkillResult,
} from './types.js';

const InputSchema = z.object({
  campaignId: z
    .string()
    .min(1)
    .max(200)
    .describe('Campaign id returned from a prior pixeldojo_campaign handoff.'),
});

type Input = z.infer<typeof InputSchema>;

const InputJsonSchema = {
  type: 'object',
  properties: {
    campaignId: {
      type: 'string',
      description: 'Campaign id returned from a prior pixeldojo_campaign handoff.',
    },
  },
  required: ['campaignId'],
} as const;

interface CampaignAsset {
  role: string;
  kind: 'image' | 'video';
  url: string;
  apiId: string;
  jobId: string;
  variantIndex?: number;
}

interface CampaignResultShape {
  kind: 'campaign' | 'handoff';
  campaignId: string;
  assets?: CampaignAsset[];
  product?: { name: string; description?: string; sourceUrl?: string };
  totalCreditCost?: number;
  warnings?: string[];
  message?: string;
  statusUrl?: string;
  subJobs?: Array<{ jobId: string; role: string; status: string }>;
}

interface ClientWithCampaign {
  getCampaign: (id: string) => Promise<CampaignResultShape>;
}

async function run(input: Input, ctx: SkillContext): Promise<SkillResult> {
  const client = ctx.client as unknown as ClientWithCampaign;
  const result = await client.getCampaign(input.campaignId);

  if (result.kind === 'campaign') {
    const assets = result.assets ?? [];
    const lines = [
      `Campaign ${result.campaignId} complete (${assets.length} assets):`,
      ...assets.map(
        (a) =>
          `  - ${a.role}${a.variantIndex !== undefined ? ` #${a.variantIndex}` : ''} (${a.kind}, ${a.apiId}): ${a.url}`,
      ),
      '',
      `Total credits: ${result.totalCreditCost ?? 0}.`,
      ...(result.warnings && result.warnings.length > 0
        ? [`Warnings: ${result.warnings.join('; ')}`]
        : []),
    ];
    return {
      kind: 'assets',
      text: lines.join('\n'),
      assetUrls: assets.map((a) => a.url),
    };
  }

  const stillRunning = (result.subJobs ?? []).filter(
    (s) => s.status !== 'completed' && s.status !== 'failed',
  );
  return {
    kind: 'handoff',
    text:
      `Campaign ${result.campaignId}: ` +
      (stillRunning.length > 0
        ? `${stillRunning.length} of ${result.subJobs?.length ?? 0} sub-jobs still ${stillRunning[0].status}. ` +
          `Wait a few seconds, then poll again.`
        : `aggregate state pending. Poll again shortly.`),
    jobId: result.campaignId,
    statusUrl: result.statusUrl ?? ctx.buildStatusUrl(result.campaignId),
  };
}

export const campaignStatusSkill: SkillModule<Input> = {
  name: 'pixeldojo_campaign_status',
  description:
    'Poll a campaign by campaignId returned from pixeldojo_campaign. Returns assets when every sub-job is done, or a handoff describing what is still in flight.',
  inputZod: InputSchema,
  inputJsonSchema: InputJsonSchema,
  allowedModels: [],
  defaultModel: '',
  run,
};
