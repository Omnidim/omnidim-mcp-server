# Reporting issues

Found a bug, a performance problem, or unexpected behaviour with `@omnidim-ai/mcp-server`? Open an issue: https://github.com/Omnidim/omnidim-mcp-server/issues

## What to include

Run the diagnostics command and paste its output:

```bash
npx -y @omnidim-ai/mcp-server doctor
```

It reports your package/Node/OS versions, which MCP clients are detected, whether the backend is reachable, and the most recent errors from the local log. It never prints your API key. Review the output before posting.

Then add:

- Your MCP client (Claude Code, Claude Desktop, Cursor, Windsurf, MCP Inspector, etc.)
- Steps to reproduce
- What you expected vs. what happened

For deeper detail, set `OMNIDIM_DEBUG=1` in the env block for verbose stderr from the server, and check the full local log at `~/.config/omnidim/logs/mcp.log`.

## Security issues

Do not file security vulnerabilities as public issues. See [SECURITY.md](./SECURITY.md) for the private disclosure process.

## Questions about the OmniDimension product

Open an issue here only when it relates to the MCP server itself. For account, billing, agent configuration, or platform questions, contact `support@omnidim.io` directly.

## Feature requests

Open an issue and tag it `enhancement`. Describe the use case before the implementation idea: what are you trying to do, what is blocking you today, what would the ideal experience look like.
