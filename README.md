# @omnidim-ai/mcp-server

Model Context Protocol server for [OmniDimension](https://omnidim.io). Drive voice agents, dispatch calls, manage knowledge bases, and run simulations from Claude, Cursor, Windsurf, or any MCP-compatible client.

## Quick start

```bash
npx -y @omnidim-ai/mcp-server setup
```

Reuses a saved API key from `~/.config/omnidim/credentials` if one exists, otherwise prompts for a new one and validates it. Then installs the server in any detected MCP client (Claude Code, Claude Desktop, Cursor, Windsurf). Get an API key at [omnidim.io/api-management](https://omnidim.io/api-management).

## Commands

| Command | What it does |
|---|---|
| `setup` | Validates an API key (reuses the saved one if present) and installs the server in detected MCP clients |
| `telemetry enable` / `telemetry disable` / `telemetry status` | Manage anonymous usage telemetry |

## Manual install

### Claude Code

```bash
claude mcp add omnidim -- npx -y @omnidim-ai/mcp-server
```

### Claude Desktop, Cursor, Windsurf

Add this block to your MCP client config:

```json
{
  "mcpServers": {
    "omnidim": {
      "command": "npx",
      "args": ["-y", "@omnidim-ai/mcp-server"],
      "env": {
        "OMNIDIM_API_KEY": "your_api_key_here"
      }
    }
  }
}
```

Get your API key from [omnidim.io/api-management](https://omnidim.io/api-management).

**Config file locations:**

| Client | Path |
|---|---|
| Claude Desktop (macOS) | `~/Library/Application Support/Claude/claude_desktop_config.json` |
| Claude Desktop (Windows) | `%APPDATA%\Claude\claude_desktop_config.json` |
| Cursor | `~/.cursor/mcp.json` |
| Windsurf | `~/.codeium/windsurf/mcp_config.json` |

## Tools

| Surface | Tools |
|---|---|
| Agents | create, update, list, get, delete |
| Calls | dispatch, list logs, get log |
| Bulk calls | create, fetch, get, actions, cancel, live status |
| Knowledge base | list, upload, attach, detach, delete |
| Phone numbers | list, attach, detach, import (Twilio, Exotel, SIP) |
| Providers | list LLMs, list voices, list STT, list TTS |
| Simulations | create, list, get, update, delete, start, stop, enhance prompt |
| Reseller | child orgs, users, credits (reseller accounts only) |

Full API reference: [docs.omnidim.io](https://docs.omnidim.io).

## Local development

```bash
git clone https://github.com/Omnidim/omnidim-mcp-server
cd omnidim-mcp-server
npm install
npm run build
OMNIDIM_API_KEY=sk_... npm start
```

Inspect tools and call them interactively:

```bash
OMNIDIM_API_KEY=sk_... npx @modelcontextprotocol/inspector node build/index.js
```

## Telemetry

Anonymous usage data is sent to help us improve the package: package version, Node version, OS family, install count, session boots, and tool names. **No API keys, no tool inputs/outputs, no personal info.**

Disable with:

```bash
npx -y @omnidim-ai/mcp-server telemetry disable
```

Full field-by-field breakdown and other opt-out options in [TELEMETRY.md](./TELEMETRY.md).

## Reporting issues

See [ISSUES.md](./ISSUES.md) for how to file bug reports, request features, or get help.

## License

[MIT](./LICENSE)
