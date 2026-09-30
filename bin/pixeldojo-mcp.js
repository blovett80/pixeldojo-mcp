#!/usr/bin/env node
// Tiny launcher. The real CLI logic lives in dist/cli.js (built by tsup).
// This file stays intentionally minimal so we don't bundle anything heavy
// for `npx @pixeldojo/mcp` cold-start latency.
import('../dist/cli.js').then((m) => m.main()).catch((err) => {
  // eslint-disable-next-line no-console
  console.error('[pixeldojo-mcp] Failed to start:', err && err.message ? err.message : err);
  process.exit(1);
});
