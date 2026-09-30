# PixelDojo MCP

Image, video, audio and film generation for any AI agent. One connection gives Claude, Cursor, VS Code, Windsurf, ChatGPT and every other [MCP](https://modelcontextprotocol.io) client access to 140+ generative models, plus studios for product ads, short films, faceless videos and consistent characters.

- Hosted server: `https://pixeldojo.ai/mcp` (streamable HTTP, browser sign-in, no API key needed)
- Local server: `npx -y @pixeldojo/mcp` (stdio, uses your API key)
- Setup guides for every client: https://pixeldojo.ai/skills

## What you can ask for

- "Make a cinematic product photo of my sneaker on wet asphalt at night."
- "Turn this product page into a UGC video ad: <url>"
- "Translate this ad into Spanish and keep the layout."
- "Keep this character consistent across six shots."
- "Plan a 30-second noir short film about a lost key and show me the cost."
- "Make a 60-second faceless explainer about why we yawn."

PixelDojo picks a model from its catalog (Flux, Seedream, Seedance, Veo, Kling, WAN, Nano Banana, GPT Image, Seed Audio and more), renders it, and returns download links.

## Connect in 30 seconds

**Claude Code**

```bash
claude mcp add --transport http pixeldojo https://pixeldojo.ai/mcp
```

**Claude Desktop and claude.ai:** add a custom connector with the URL `https://pixeldojo.ai/mcp` and approve in your browser.

**Cursor** (`.cursor/mcp.json`)

```json
{ "mcpServers": { "pixeldojo": { "url": "https://pixeldojo.ai/mcp" } } }
```

**VS Code** (`.vscode/mcp.json`)

```json
{ "servers": { "pixeldojo": { "type": "http", "url": "https://pixeldojo.ai/mcp" } } }
```

**Windsurf** (`mcp_config.json`)

```json
{ "mcpServers": { "pixeldojo": { "serverUrl": "https://pixeldojo.ai/mcp" } } }
```

**Local (stdio) with an API key.** Create a key at https://pixeldojo.ai/api-platform/api-keys, then:

```json
{
  "mcpServers": {
    "pixeldojo": {
      "command": "npx",
      "args": ["-y", "@pixeldojo/mcp"],
      "env": { "PIXELDOJO_API_KEY": "pd_your_api_key_here" }
    }
  }
}
```

The hosted server also accepts `Authorization: Bearer pd_...`.

## Tools

| Tool | What it does |
|---|---|
| `pixeldojo_generate` | Any prompt to an image or video. Defaults to Seedream for stills; pass any model id for video and more. |
| `pixeldojo_edit` | Change existing images with a text instruction, multi-image capable. |
| `pixeldojo_character` | Consistent characters across shots. |
| `pixeldojo_storyboard` | One video shot from a scene brief. |
| `pixeldojo_film` | Film Studio: a multi-shot film from an idea, or a music video synced to your song. |
| `pixeldojo_video` | Change, move or extend an existing clip. |
| `pixeldojo_episode` | Faceless Studio: a narrated video episode from a topic. |
| `pixeldojo_ad` | Marketing Studio: a product video ad from a URL or product images. |
| `pixeldojo_campaign`, `pixeldojo_campaign_status` | One product URL to a hero image, lifestyle set and optional video. |
| `pixeldojo_from_url` | Product page URL to structured product info. Free. |
| `pixeldojo_upscale` | Enhance an image up to 16x or a video up to 4K. |
| `pixeldojo_audio` | Dialogue, effects and music in one clip. |
| `pixeldojo_library` | Search your saved media and recent generations. |
| `pixeldojo_save_workflow`, `pixeldojo_run_workflow`, `pixeldojo_list_workflows` | Save a multi-step chain once, run it by name anywhere. |
| `pixeldojo_upload` | Local file to a 24-hour temporary URL (stdio only). |
| `pixeldojo_status` | Check a long-running job by `jobId`. |

The hosted server exposes 18 of these (no `pixeldojo_upload`, since it cannot read your local files).

## How jobs work

Generation tools wait up to 30 seconds. Fast renders return straight away. Longer ones return a `jobId` and your agent follows up with `pixeldojo_status`. Generated asset URLs expire one hour after creation, so download anything you want to keep. Finished films stay in your PixelDojo library.

## Credits and auth

Renders use the credits on your PixelDojo account (plans and credit packs: https://pixeldojo.ai/pricing). Failed jobs are refunded. Hosted auth is OAuth 2.0 with browser approval, or an API key. API keys are redacted from every log.

## Links

Docs: https://pixeldojo.ai/skills · API: https://pixeldojo.ai/api-platform · llms.txt: https://pixeldojo.ai/llms.txt · Support: support@pixeldojo.ai · Privacy: https://pixeldojo.ai/privacy-policy · Terms: https://pixeldojo.ai/terms

## Telemetry

Requests send `x-pixeldojo-source: mcp/<version>` and `x-pixeldojo-skill: <tool>` headers so PixelDojo can attribute traffic. Nothing is sent beyond the API call itself.

## License

MIT
