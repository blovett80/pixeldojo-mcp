/**
 * Header-injecting wrapper around `@pixeldojo/sdk`'s PixelDojoClient.
 *
 * Per Eng review E2 + E3:
 *   - Depends on @pixeldojo/sdk for run/getJob/listModels/getModelSchema
 *     (DRY — no /api/v1 client duplication).
 *   - Injects `x-pixeldojo-source: mcp/<version>` and `x-pixeldojo-skill:
 *     <skill-name>` headers on every API call so Tool Health can attribute
 *     MCP traffic separately from raw REST.
 *
 * The SDK exposes a `fetch` injection point in its constructor — we wrap
 * the global `fetch` to add headers without monkey-patching anything.
 */
import { PixelDojoClient } from '@pixeldojo/sdk';
import type { PixelDojoClientOptions } from '@pixeldojo/sdk';

export interface MakeClientOptions extends PixelDojoClientOptions {
  /** MCP package version for the `x-pixeldojo-source` header value. */
  mcpVersion: string;
  /** Optional skill name; if set, written to `x-pixeldojo-skill`. */
  skillName?: string;
  /** Optional fetch override (tests). Defaults to `globalThis.fetch`. */
  baseFetch?: typeof globalThis.fetch;
}

/**
 * Build a PixelDojoClient with attribution headers baked in.
 *
 * Each call's headers include both the source tag and the requesting
 * skill so the server can record per-skill error rates without the
 * client passing skill metadata explicitly through every call.
 */
export function makeAttributedClient(options: MakeClientOptions): PixelDojoClient {
  const { mcpVersion, skillName, baseFetch, ...sdkOptions } = options;
  const real = baseFetch ?? globalThis.fetch.bind(globalThis);

  const wrappedFetch: typeof globalThis.fetch = (input, init) => {
    const headers = new Headers(init?.headers);
    headers.set('x-pixeldojo-source', `mcp/${mcpVersion}`);
    if (skillName) headers.set('x-pixeldojo-skill', skillName);
    return real(input, { ...init, headers });
  };

  return new PixelDojoClient({
    ...sdkOptions,
    fetch: wrappedFetch,
  });
}
