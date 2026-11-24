# @omnidim-ai/mcp-server

[![npm version](https://img.shields.io/npm/v/@omnidim-ai/mcp-server)](https://www.npmjs.com/package/@omnidim-ai/mcp-server)
[![npm downloads](https://img.shields.io/npm/dm/@omnidim-ai/mcp-server)](https://www.npmjs.com/package/@omnidim-ai/mcp-server)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue)](./LICENSE)
[![OmniDimension MCP server on Glama](https://glama.ai/mcp/servers/Omnidim/omnidim-mcp-server/badges/score.svg)](https://glama.ai/mcp/servers/Omnidim/omnidim-mcp-server)

The [Model Context Protocol](https://modelcontextprotocol.io) server for [OmniDimension](https://omnidim.io). Connect Claude, ChatGPT, Cursor, VS Code or any MCP client to build and deploy voice AI agents, make calls, and run call campaigns, workflows and WhatsApp in your account.

## Connect the hosted server

[![Install in Cursor](https://cursor.com/deeplink/mcp-install-dark.svg)](https://cursor.com/en/install-mcp?name=omnidim&config=eyJ1cmwiOiJodHRwczovL21jcC5vbW5pZGltLmlvL21jcCJ9)
[![Install in VS Code](https://img.shields.io/badge/VS_Code-Install_omnidim-0098FF?logo=visualstudiocode&logoColor=white)](https://insiders.vscode.dev/redirect/mcp/install?name=omnidim&config=%7B%22type%22%3A%22http%22%2C%22url%22%3A%22https%3A%2F%2Fmcp.omnidim.io%2Fmcp%22%7D)

The hosted server lives at `https://mcp.omnidim.io/mcp`. You sign in with your OmniDimension account in the browser, so you need no API key.

Claude Code:

```bash
claude mcp add --transport http omnidim https://mcp.omnidim.io/mcp
```

Codex:

```bash
codex mcp add omnidim --url https://mcp.omnidim.io/mcp
```

| Client | Setup |
|---|---|
| Claude Desktop, Claude.ai | Settings, Connectors, Add custom connector, then paste `https://mcp.omnidim.io/mcp`. [Claude guide](https://docs.omnidim.io/docs/mcp/connect/claude-desktop) |
| ChatGPT | Add `https://mcp.omnidim.io/mcp` as a custom connector. [MCP overview](https://docs.omnidim.io/docs/mcp) |
| Claude Code | Run the command above, then `/mcp` to sign in. [Claude Code guide](https://docs.omnidim.io/docs/mcp/connect/claude-code) |
| Codex | Run the command above, then `codex mcp login omnidim`. [Codex guide](https://docs.omnidim.io/docs/mcp/connect/codex) |
| Cursor | The button above, or the [Cursor guide](https://docs.omnidim.io/docs/mcp/connect/cursor) |
| VS Code | The button above, or the [VS Code guide](https://docs.omnidim.io/docs/mcp/connect/vscode) |
| Windsurf | [Windsurf guide](https://docs.omnidim.io/docs/mcp/connect/windsurf) |
| Any other MCP client | Add `https://mcp.omnidim.io/mcp` as a remote server |

## Try these prompts

- "What agents do I have, and which phone numbers are attached to them?"
- "Build a receptionist agent for a dental clinic that books appointments, then give it a phone number."
- "Call +15550100 with my receptionist agent and show me the transcript when the call ends."
- "Start a campaign that calls the contacts in this CSV, 5 calls at a time, between 10 AM and 6 PM."
- "After each call, sort it into booked, callback or not interested, and post the booked ones to Slack."
- "Which calls failed yesterday, and why?"

The server also ships prompts for common jobs (`provision_agent`, `build_outbound_campaign`, `build_workflow`, `audit_calls`, `restore_agent_version`) and guide resources under `omnidim://guide/` and `omnidim://reference/`.

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

**Read-only mode:** add `"OMNIDIM_READONLY": "1"` to `env`. The server then offers only the tools that read data (agents, call logs, campaigns, numbers), so the agent cannot change your account or place a call.

## Tools

Each tool maps to one endpoint of the [OmniDimension API](https://docs.omnidim.io), or to a few endpoints that take the same inputs, picked by an action field.

| Area | What your agent can do | Tools |
|---|---|---|
| Agents | Build, edit and version voice agents, and set what happens after each call | 13 |
| Calls | Place a call and read call logs and transcripts | 3 |
| Call campaigns | Create, start, pace and retry bulk call campaigns | 15 |
| Phone numbers | Search, buy, attach and import numbers (Twilio, Exotel, SIP) | 9 |
| Workflows | Build, test and publish post-call workflows | 14 |
| Knowledge base | Upload files and attach them to agents | 4 |
| Voices and providers | Pick voices, models and providers, and manage cloned voices | 8 |
| Integrations | Connect agents to your APIs and apps | 4 |
| WhatsApp | Numbers, templates, conversations and campaigns | 23 |
| Docs | Search and read [docs.omnidim.io](https://docs.omnidim.io), with no access to your account | 2 |
| Account | Check your balance and start a web call session | 2 |

<details>
<summary>All tool names</summary>

| Area | Tools |
|---|---|
| Agents | `listAgents`, `createAgent`, `getAgent`, `updateAgent`, `deleteAgent`, `listPostCallActions`, `addPostCallAction`, `deletePostCallAction`, `updatePostCallAction`, `listAgentVersions`, `createAgentVersion`, `diffAgentVersion`, `agentVersionActions` |
| Calls | `dispatchCall`, `listCallLogs`, `getCallLog` |
| Call campaigns | `fetchBulkCalls`, `createBulkCall`, `addBulkCallContact`, `getBulkCall`, `bulkCallActions`, `listBulkCallLines`, `listBulkCallNumbers`, `addBulkCallNumber`, `setBulkCallNumberActive`, `addBulkCallContacts`, `setBulkCallConcurrency`, `setBulkCallRotation`, `retryBulkCall`, `setBulkCallDailyTimeControl`, `getBulkCallLiveStatus` |
| Phone numbers | `listPhoneNumbers`, `searchPhoneNumbers`, `purchasePhoneNumber`, `releasePhoneNumber`, `setPhoneNumberAutoRenew`, `phoneNumberAgentActions`, `importTwilioNumber`, `importExotelNumber`, `importSipTrunk` |
| Workflows | `listWorkflowNodeTypes`, `getWorkflowNodeType`, `listWorkflowFieldOptions`, `listWorkflows`, `createWorkflow`, `getWorkflow`, `deleteWorkflow`, `editWorkflow`, `validateWorkflow`, `publishWorkflow`, `workflowActions`, `testWorkflow`, `getWorkflowExecution`, `showWorkflow` |
| Knowledge base | `listKnowledgeBaseFiles`, `uploadKnowledgeBaseFile`, `agentKnowledgeBaseActions`, `deleteKnowledgeBaseFile` |
| Voices and providers | `listProviders`, `listVoices`, `getVoice`, `listClonedVoices`, `getClonedVoice`, `deleteClonedVoice`, `updateClonedVoice`, `regenerateClonedVoiceSample` |
| Integrations | `listIntegrations`, `createCustomApiIntegration`, `listAgentIntegrations`, `agentIntegrationActions` |
| WhatsApp | `listWhatsappNumbers`, `importWhatsappNumbers`, `previewWhatsappNumbers`, `getWhatsappNumber`, `listWhatsappTemplates`, `syncWhatsappTemplates`, `getWhatsappCalling`, `setWhatsappCalling`, `listWhatsappConversations`, `getWhatsappConversation`, `whatsappConversationActions`, `listWhatsappMessages`, `sendWhatsappMessage`, `getWhatsappMessage`, `listWhatsappOptOuts`, `addWhatsappOptOut`, `liftWhatsappOptOut`, `listWhatsappCampaigns`, `createWhatsappCampaign`, `getWhatsappCampaign`, `listWhatsappCampaignContacts`, `addWhatsappCampaignContacts`, `whatsappCampaignActions` |
| Docs | `searchDocs`, `readDoc` |
| Account | `getAccountBalance`, `createSession` |

</details>

The docs tools read the public docs only and never send your API key there.

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
