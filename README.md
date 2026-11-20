# @omnidim-ai/mcp-server

[![npm version](https://img.shields.io/npm/v/@omnidim-ai/mcp-server)](https://www.npmjs.com/package/@omnidim-ai/mcp-server)
[![npm downloads](https://img.shields.io/npm/dm/@omnidim-ai/mcp-server)](https://www.npmjs.com/package/@omnidim-ai/mcp-server)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue)](./LICENSE)

Model Context Protocol server for [OmniDimension](https://omnidim.io). Build voice agents, give them phone numbers, place calls and run call campaigns from Claude, ChatGPT, Cursor, VS Code, or any MCP client.

## Connect the hosted server

[![Install in Cursor](https://cursor.com/deeplink/mcp-install-dark.svg)](https://cursor.com/en/install-mcp?name=omnidim&config=eyJ1cmwiOiJodHRwczovL21jcC5vbW5pZGltLmlvL21jcCJ9)
[![Install in VS Code](https://img.shields.io/badge/VS_Code-Install_omnidim-0098FF?logo=visualstudiocode&logoColor=white)](https://insiders.vscode.dev/redirect/mcp/install?name=omnidim&config=%7B%22type%22%3A%22http%22%2C%22url%22%3A%22https%3A%2F%2Fmcp.omnidim.io%2Fmcp%22%7D)
[![Install in VS Code Insiders](https://img.shields.io/badge/VS_Code_Insiders-Install_omnidim-24bfa5?logo=visualstudiocode&logoColor=white)](https://insiders.vscode.dev/redirect/mcp/install?name=omnidim&config=%7B%22type%22%3A%22http%22%2C%22url%22%3A%22https%3A%2F%2Fmcp.omnidim.io%2Fmcp%22%7D&quality=insiders)

The hosted server lives at `https://mcp.omnidim.io/mcp`. You sign in with your OmniDimension account in the browser, so you need no API key.

| Client | Setup |
|---|---|
| Claude Code | `claude mcp add --transport http omnidim https://mcp.omnidim.io/mcp` |
| Claude Desktop, Claude.ai | [Claude guide](https://docs.omnidim.io/docs/mcp/connect/claude-desktop) |
| Cursor | Use the button above, or the [Cursor guide](https://docs.omnidim.io/docs/mcp/connect/cursor) |
| VS Code | Use the button above, or the [VS Code guide](https://docs.omnidim.io/docs/mcp/connect/vscode) |
| Windsurf | [Windsurf guide](https://docs.omnidim.io/docs/mcp/connect/windsurf) |
| Codex | [Codex guide](https://docs.omnidim.io/docs/mcp/connect/codex) |
| ChatGPT and other clients | Add `https://mcp.omnidim.io/mcp` as a custom connector. See the [MCP overview](https://docs.omnidim.io/docs/mcp) |

## Try these prompts

- "What agents do I have, and which phone numbers are attached to them?"
- "Build a receptionist agent for a dental clinic that books appointments, then give it a phone number."
- "Call +15550100 with my receptionist agent and show me the transcript when the call ends."
- "Start a campaign that calls the contacts in this CSV, 5 calls at a time, between 10 AM and 6 PM."
- "Which calls failed yesterday, and why?"

The server also ships prompts for common jobs (`provision_agent`, `build_outbound_campaign`, `build_workflow`, `audit_calls`, `restore_agent_version`) and guide resources under `omnidim://guide/`.

## Run it locally with an API key

Use the local stdio server for headless or CI use, or for clients without remote MCP support.

### Quick start

```bash
npx -y @omnidim-ai/mcp-server setup
```

Reuses a saved API key from `~/.config/omnidim/credentials` if one exists, otherwise prompts for a new one and validates it. Then installs the server in any detected MCP client (Claude Code, Claude Desktop, Cursor, Windsurf). Get an API key at [omnidim.io/api-management](https://omnidim.io/api-management).

### Manual install

#### Claude Code

```bash
claude mcp add omnidim -- npx -y @omnidim-ai/mcp-server
```

#### Claude Desktop, Cursor, Windsurf

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

Each tool maps to one endpoint of the [OmniDimension API](https://docs.omnidim.io).

| Group | Tools |
|---|---|
| Agents | `listAgents`, `createAgent`, `getAgent`, `updateAgent`, `deleteAgent`, `listPostCallActions`, `addPostCallAction`, `deletePostCallAction`, `updatePostCallAction`, `listAgentVersions`, `createAgentVersion`, `deleteAgentVersion`, `renameAgentVersion`, `diffAgentVersion`, `restoreAgentVersion` |
| Calls | `dispatchCall`, `listCallLogs`, `getCallLog` |
| Bulk calls | `fetchBulkCalls`, `createBulkCall`, `addBulkCallContact`, `getBulkCall`, `bulkCallActions`, `cancelBulkCall`, `listBulkCallLines`, `listBulkCallNumbers`, `addBulkCallNumber`, `setBulkCallNumberActive`, `addBulkCallContacts`, `startBulkCall`, `setBulkCallConcurrency`, `retryBulkCall`, `setBulkCallDailyTimeControl`, `getBulkCallLiveStatus` |
| Phone numbers | `listPhoneNumbers`, `searchPhoneNumbers`, `purchasePhoneNumber`, `releasePhoneNumber`, `attachPhoneNumber`, `detachPhoneNumber`, `importTwilioNumber`, `importExotelNumber`, `importSipTrunk` |
| Knowledge base | `listKnowledgeBaseFiles`, `canUploadFile`, `uploadKnowledgeBaseFile`, `attachKnowledgeBaseFiles`, `detachKnowledgeBaseFiles`, `deleteKnowledgeBaseFile` |
| Workflows | `listWorkflowNodeTypes`, `getWorkflowNodeType`, `listWorkflowFieldOptions`, `listWorkflows`, `createWorkflow`, `getWorkflow`, `deleteWorkflow`, `editWorkflow`, `validateWorkflow`, `publishWorkflow`, `activateWorkflow`, `deactivateWorkflow`, `testWorkflow`, `getWorkflowExecution` |
| Voice cloning | `listClonedVoices`, `createClonedVoice`, `getClonedVoice`, `deleteClonedVoice`, `updateClonedVoice`, `getClonedVoiceSample`, `regenerateClonedVoiceSample` |
| Providers | `listLLMProviders`, `listVoices`, `listSTTProviders`, `listTTSProviders`, `listAllProviders`, `getVoice` |
| Account | `getAccountBalance` |
| Integrations | `listIntegrations` |
| Sessions | `createSession` |

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

Anonymous usage data is sent to help us improve the package: package version, Node version, OS family, install count, session boots, tool names, and setup or crash outcomes as short error *categories* (e.g. `config_write_error`, `http_500`). **No API keys, no tool inputs/outputs, no error messages, no file paths, no personal info.**

Disable with:

```bash
npx -y @omnidim-ai/mcp-server telemetry disable
```

Full field-by-field breakdown and other opt-out options in [TELEMETRY.md](./TELEMETRY.md).

## Troubleshooting

Run the diagnostics command to see versions, detected clients, backend reachability, and recent errors:

```bash
npx -y @omnidim-ai/mcp-server doctor
```

It never prints your API key. A local log of errors is kept at `~/.config/omnidim/logs/mcp.log` (stays on your machine, never sent).

## Reporting issues

See [ISSUES.md](./ISSUES.md) for how to file bug reports, request features, or get help. Paste the `doctor` output into your report.

## License

[MIT](./LICENSE)
