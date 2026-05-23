# Reporting issues

Found a bug, a performance problem, or unexpected behaviour with `@omnidim-ai/mcp-server`? Open an issue: https://github.com/Omnidim/omnidim-mcp-server/issues

## What to include

- Operating system and version
- Node.js version (`node --version`)
- Package version (printed when the server starts, or `npm view @omnidim-ai/mcp-server version`)
- Your MCP client (Claude Code, Claude Desktop, Cursor, Windsurf, MCP Inspector, etc.)
- Steps to reproduce
- What you expected vs. what happened
- Relevant logs from your MCP client. Set `OMNIDIM_DEBUG=1` in the env block to get verbose stderr logs from the server.

## Security issues

Do not file security vulnerabilities as public issues. See [SECURITY.md](./SECURITY.md) for the private disclosure process.

## Questions about the OmniDimension product

Open an issue here only when it relates to the MCP server itself. For account, billing, agent configuration, or platform questions, contact `support@omnidim.io` directly.

## Feature requests

Open an issue and tag it `enhancement`. Describe the use case before the implementation idea: what are you trying to do, what is blocking you today, what would the ideal experience look like.
