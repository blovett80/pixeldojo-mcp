/**
 * CLI entry — run by the bin shim at `bin/pixeldojo-mcp.js`.
 *
 * Subcommands:
 *   - (default, no args) Run the MCP server over stdio. This is what
 *     Claude Code / Cursor / OpenClaw spawn when configured.
 *   - `init` Print the MCP host config snippet for Claude Code, Cursor,
 *     and a generic shape — copy/paste into your editor's mcp config.
 */
import { runStdio, PACKAGE_VERSION } from './server.js';

function printInit() {
  // eslint-disable-next-line no-console
  console.log(
    [
      `# PixelDojo MCP — install snippets`,
      `# Package version: ${PACKAGE_VERSION}`,
      ``,
      `# 1. Set your API key`,
      `#    Get one at https://pixeldojo.ai/api-platform/api-keys`,
      `export PIXELDOJO_API_KEY=pd_your_api_key_here`,
      ``,
      `# 2. Add this MCP entry to your editor / agent config:`,
      ``,
      `# ── Claude Code (~/.config/claude-code/mcp.json) ──`,
      `{`,
      `  "mcpServers": {`,
      `    "pixeldojo": {`,
      `      "command": "npx",`,
      `      "args": ["-y", "@pixeldojo/mcp"],`,
      `      "env": {`,
      `        "PIXELDOJO_API_KEY": "pd_your_api_key_here"`,
      `      }`,
      `    }`,
      `  }`,
      `}`,
      ``,
      `# ── Cursor (.cursor/mcp.json in your project) ──`,
      `# Same shape as above.`,
      ``,
      `# 3. Restart your agent. You'll see these tools:`,
      `#    pixeldojo_generate       Any prompt → image or video.`,
      `#    pixeldojo_edit           Change an image with a text instruction.`,
      `#    pixeldojo_character      Consistent characters across shots.`,
      `#    pixeldojo_storyboard     Multi-shot scenes from one brief.`,
      `#    pixeldojo_upscale        Enhance any image or video.`,
      `#    pixeldojo_audio          Voices + effects + music in one clip.`,
      `#    pixeldojo_library        Search your saved media + generations.`,
      `#    pixeldojo_*_workflow     Save / run / list multi-step chains.`,
      `#    pixeldojo_upload         Local file → temp URL for references.`,
      `#    pixeldojo_from_url       Product URL → structured product info.`,
      `#    pixeldojo_campaign*      Product URL → full launch pack.`,
      `#    pixeldojo_status         Poll long-running jobs.`,
      ``,
    ].join('\n'),
  );
}

function printVersion() {
  // eslint-disable-next-line no-console
  console.log(`@pixeldojo/mcp v${PACKAGE_VERSION}`);
}

function printHelp() {
  // eslint-disable-next-line no-console
  console.log(
    [
      `@pixeldojo/mcp v${PACKAGE_VERSION} — PixelDojo MCP server`,
      ``,
      `Usage:`,
      `  pixeldojo-mcp                 Start the MCP server over stdio (default).`,
      `  pixeldojo-mcp init            Print install snippets for Claude Code / Cursor.`,
      `  pixeldojo-mcp --version       Print package version.`,
      `  pixeldojo-mcp --help          Show this message.`,
      ``,
      `Auth: set PIXELDOJO_API_KEY in your environment.`,
      `Get a key at https://pixeldojo.ai/api-platform/api-keys`,
    ].join('\n'),
  );
}

export async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const cmd = args[0];

  if (cmd === 'init') {
    printInit();
    return;
  }
  if (cmd === '--version' || cmd === '-v') {
    printVersion();
    return;
  }
  if (cmd === '--help' || cmd === '-h') {
    printHelp();
    return;
  }
  if (cmd && !cmd.startsWith('-')) {
    // eslint-disable-next-line no-console
    console.error(`Unknown command "${cmd}". Run 'pixeldojo-mcp --help' for usage.`);
    process.exit(2);
  }

  const apiKey = process.env.PIXELDOJO_API_KEY;
  if (!apiKey) {
    // eslint-disable-next-line no-console
    console.error(
      [
        '[pixeldojo-mcp] Missing PIXELDOJO_API_KEY environment variable.',
        '',
        '  1. Get a key: https://pixeldojo.ai/api-platform/api-keys',
        '  2. Set: export PIXELDOJO_API_KEY=pd_your_api_key_here',
        '  3. Restart your agent',
        '',
        'For copy-paste config snippets: pixeldojo-mcp init',
      ].join('\n'),
    );
    process.exit(1);
  }

  await runStdio({
    apiKey,
    baseUrl: process.env.PIXELDOJO_BASE_URL ?? 'https://pixeldojo.ai',
  });
}
