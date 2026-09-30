/**
 * MCP server bootstrap. Wires the named skills to the MCP `tools/list` +
 * `tools/call` handlers and runs over stdio.
 *
 * Architecture:
 *   - tools/list: returns every skill's name + description + inputSchema.
 *   - tools/call: parses input via Zod, dispatches to the skill module,
 *     converts the SkillResult into MCP content blocks, returns to host.
 *   - errors are translated at the boundary: provider failures, missing
 *     API keys, unknown skills all surface as actionable MCP error
 *     payloads (never raw stack traces).
 */
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { makeAttributedClient } from './client.js';
import { ALL_SKILLS, findSkill, toolListing } from './skills/index.js';
import type { SkillContext, SkillResult } from './skills/types.js';
import { makeRedactedLogger } from './redact.js';

// Stamped from package.json at build time (tsup define) so the MCP
// handshake and telemetry headers can't drift from the published version.
// The '0.0.0-dev' fallback only appears when running un-built source.
declare const __PACKAGE_VERSION__: string | undefined;
export const PACKAGE_VERSION =
  typeof __PACKAGE_VERSION__ === 'string' ? __PACKAGE_VERSION__ : '0.0.0-dev';

/**
 * Server-level context sent on `initialize`, shared by this stdio server and
 * the hosted /api/mcp route. Facts that span tools only: tool choice belongs
 * in each tool's own description. API/MCP outputs live under the temp
 * bucket's api-outputs/ folder and are swept one hour after they land;
 * finished films are saved to the account library, so they stay.
 */
export const SERVER_INSTRUCTIONS =
  'PixelDojo generates images, video, audio and short films across 100+ models, billed in credits from the connected PixelDojo account. A job that runs past the 30-second wait returns a jobId to check later; check it rather than submitting again, since every new submission is charged. Generated asset URLs are deleted one hour after they are created, so download anything the user wants to keep. Finished films are the exception and stay in the account library.';

export interface ServerOptions {
  apiKey: string;
  baseUrl?: string;
  packageVersion?: string;
  /** Inject for tests. Defaults to the real fetch. */
  baseFetch?: typeof globalThis.fetch;
}

/**
 * Build the configured MCP `Server` instance with handlers wired in.
 * Caller is responsible for connecting it to a transport (stdio in
 * production, mock in tests).
 */
export function buildServer(options: ServerOptions): Server {
  if (!options.apiKey) {
    throw new Error(
      'apiKey is required. Set PIXELDOJO_API_KEY env var or pass apiKey to buildServer().',
    );
  }

  const version = options.packageVersion ?? PACKAGE_VERSION;
  const baseUrl = options.baseUrl ?? 'https://pixeldojo.ai';
  const logger = makeRedactedLogger();

  const server = new Server(
    {
      name: 'pixeldojo',
      version,
    },
    {
      capabilities: {
        tools: {},
      },
      instructions: SERVER_INSTRUCTIONS,
    },
  );

  // tools/list — advertise every named skill.
  server.setRequestHandler(ListToolsRequestSchema, async () => {
    return {
      tools: ALL_SKILLS.map(toolListing),
    };
  });

  // tools/call — parse input, dispatch, translate result.
  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const skillName = req.params.name;
    const skill = findSkill(skillName);
    if (!skill) {
      const available = ALL_SKILLS.map((s) => s.name).join(', ');
      return {
        isError: true,
        content: [
          {
            type: 'text',
            text: `Unknown skill "${skillName}". Available: ${available}.`,
          },
        ],
      };
    }

    const parsed = skill.inputZod.safeParse(req.params.arguments ?? {});
    if (!parsed.success) {
      const issues = parsed.error.issues
        .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
        .join('; ');
      return {
        isError: true,
        content: [
          {
            type: 'text',
            text: `Invalid input for ${skillName}: ${issues}`,
          },
        ],
      };
    }

    // Build a client with skill-tagged headers for this call.
    const client = makeAttributedClient({
      apiKey: options.apiKey,
      baseUrl,
      mcpVersion: version,
      skillName,
      baseFetch: options.baseFetch,
    });

    const ctx: SkillContext = {
      client,
      apiKey: options.apiKey,
      baseUrl,
      mcpVersion: version,
      localFiles: true, // stdio: the caller's own machine
      logger,
      buildStatusUrl: (jobId) => `${baseUrl}/api/v1/jobs/${encodeURIComponent(jobId)}`,
    };

    try {
      const result = await skill.run(parsed.data, ctx);
      return skillResultToMcpResponse(result);
    } catch (err) {
      const message = errorToActionableMessage(err);
      logger.error(`Skill ${skillName} failed`, message);
      return {
        isError: true,
        content: [{ type: 'text', text: message }],
      };
    }
  });

  return server;
}

/**
 * Translate a SkillResult into MCP content blocks.
 * The host renders these to the LLM; URLs in `assets` are surfaced as
 * extra text blocks so the LLM can quote them directly without needing
 * a separate `assets` shape (no MCP standard for that yet).
 */
export function skillResultToMcpResponse(result: SkillResult): {
  isError?: boolean;
  content: Array<{ type: 'text'; text: string }>;
} {
  if (result.kind === 'assets') {
    return {
      content: [
        { type: 'text', text: result.text },
        // Each URL on its own line so an LLM can copy individually.
        ...result.assetUrls.map((url) => ({ type: 'text' as const, text: url })),
      ],
    };
  }
  if (result.kind === 'handoff') {
    return {
      content: [
        { type: 'text', text: result.text },
        { type: 'text', text: `jobId: ${result.jobId}` },
        { type: 'text', text: `statusUrl: ${result.statusUrl}` },
      ],
    };
  }
  return {
    content: [{ type: 'text', text: result.text }],
  };
}

/**
 * Convert SDK / network errors to a single actionable line. Per Eng review:
 * users should never see raw provider stack traces; errors must include
 * what to do next.
 */
export function errorToActionableMessage(err: unknown): string {
  if (err == null) return 'Unknown error';
  if (typeof err === 'string') return err;
  const e = err as {
    name?: string;
    code?: string;
    status?: number;
    message?: string;
  };
  // Auth errors → tell the user where to fix it.
  if (e.status === 401 || e.code === 'auth_required' || e.name === 'AuthenticationError') {
    return (
      'Authentication failed. Check PIXELDOJO_API_KEY. ' +
      'Get a key at https://pixeldojo.ai/api-platform/api-keys.'
    );
  }
  if (e.status === 402 || e.code === 'insufficient_credits') {
    return (
      'Insufficient credits. Top up at https://pixeldojo.ai/api-platform/buy-credits.'
    );
  }
  if (e.status === 429 || e.code === 'rate_limit') {
    return 'Rate limit hit. Try again in a few seconds.';
  }
  if (e.status === 404 || e.code === 'not_found') {
    return e.message ?? 'Resource not found.';
  }
  if (e.name === 'TimeoutError') {
    return e.message ?? 'Request timed out. Try again.';
  }
  return e.message ?? 'Unknown error';
}

/**
 * Run the server over stdio. Used by the CLI; tests use buildServer
 * directly with a mock transport.
 */
export async function runStdio(options: ServerOptions): Promise<void> {
  const server = buildServer(options);
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
