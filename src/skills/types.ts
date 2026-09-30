/**
 * Shared types for MCP skill modules.
 *
 * Every named skill (pixeldojo_generate, :character, :storyboard, :upscale,
 * :status) exports an object that satisfies `SkillModule`. The server
 * registers them via `registerSkills` in `../server.ts`.
 */
import type { z } from 'zod';
import type { PixelDojoClient } from '@pixeldojo/sdk';
import type { PollResult } from '../poll.js';

export interface SkillContext {
  /** Header-injected SDK client. Each call has source + skill tag. */
  client: PixelDojoClient;
  /** Raw credentials for surfaces outside /api/v1 (the film pipeline). */
  apiKey: string;
  baseUrl: string;
  /** Resolved version string for the source attribution header. */
  mcpVersion: string;
  /**
   * True only where "local" means the caller's own machine (the stdio npm
   * server). The hosted /api/mcp route leaves it unset: there `*_path`
   * fields would read the production container's disk. Fail-closed.
   */
  localFiles?: boolean;
  /** Optional logger that already redacts pd_xxx tokens. */
  logger: { error: (msg: string, ...args: unknown[]) => void };
  /** Build a public statusUrl for a job (used in handoffs). */
  buildStatusUrl: (jobId: string) => string;
  /** Inject sleep / now for testability. Optional in production. */
  pollOverrides?: {
    now?: () => number;
    sleep?: (ms: number) => Promise<void>;
  };
}

export type SkillResultText = { kind: 'text'; text: string };
export type SkillResultAssets = {
  kind: 'assets';
  text: string;
  assetUrls: string[];
};
export type SkillResultHandoff = {
  kind: 'handoff';
  text: string;
  jobId: string;
  statusUrl: string;
};
export type SkillResult = SkillResultText | SkillResultAssets | SkillResultHandoff;

/**
 * One named skill. The MCP server reads `name`, `description`,
 * `inputSchema` (JSON Schema for `tools/list`) and dispatches via `run`.
 */
export interface SkillModule<TInput = unknown> {
  /** MCP tool name, e.g. `pixeldojo_generate`. */
  name: string;
  /** One-line description shown in `tools/list` to the LLM host. */
  description: string;
  /** Replaces `description` on the hosted server when it advertises `*_path` fields. */
  hostedDescription?: string;
  /** Zod schema for typed parsing inside the skill. */
  inputZod: z.ZodType<TInput>;
  /** JSON Schema (object) version for the MCP `tools/list` payload. */
  inputJsonSchema: Record<string, unknown>;
  /**
   * Whitelist of `apiId`s this skill is allowed to dispatch to. Treated as
   * a contract: a user-supplied `model` override must be in this list,
   * otherwise the skill returns an `UnknownModelError` with the list.
   * `null` means "any registered model" (used by `pixeldojo_generate`).
   */
  allowedModels: string[] | null;
  /** Default `apiId` if the user doesn't pass `model`. */
  defaultModel: string;
  /** Run the skill end-to-end. Returns a structured SkillResult. */
  run(input: TInput, ctx: SkillContext): Promise<SkillResult>;
}

/**
 * Render a `PollResult` as a `SkillResult`. Centralized so every skill
 * surfaces handoff / completion / failure consistently.
 */
export function pollResultToSkillResult(
  result: PollResult,
  successText: (urls: string[]) => string,
): SkillResult {
  if (result.kind === 'completed') {
    const urls = extractAssetUrls(result.job);
    return {
      kind: 'assets',
      text: successText(urls),
      assetUrls: urls,
    };
  }
  if (result.kind === 'failed') {
    const errMsg =
      typeof result.job.error === 'string'
        ? result.job.error
        : result.job.error?.message ?? 'Unknown provider error';
    return {
      kind: 'text',
      text: `Job ${result.job.jobId} failed: ${errMsg}`,
    };
  }
  return {
    kind: 'handoff',
    text:
      `Job ${result.jobId} is still running after the 30s sync window. ` +
      `Use pixeldojo_status with this jobId to check completion, or follow ${result.statusUrl}.`,
    jobId: result.jobId,
    statusUrl: result.statusUrl,
  };
}

function extractAssetUrls(job: { assets?: Array<{ url: string }>; output?: unknown }): string[] {
  if (job.assets && job.assets.length > 0) return job.assets.map((a) => a.url);
  // Fallback for completed jobs that put outputs on `output.images` /
  // `output.videos` (matches the legacy /api/v1/jobs response shape).
  const output = job.output as
    | { images?: string[]; videos?: string[]; image?: string; video?: string }
    | undefined;
  if (output?.images) return output.images;
  if (output?.videos) return output.videos;
  if (output?.image) return [output.image];
  if (output?.video) return [output.video];
  return [];
}
