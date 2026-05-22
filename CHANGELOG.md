# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.2] - 2026-05-22

### Added

- Setup help on direct run. Running `npx -y @omnidim-ai/mcp-server` from a terminal now prints install instructions for Claude Code, Claude Desktop, Cursor, and Windsurf, instead of waiting silently for input.
- Branded startup banner that identifies the server as OmniDimension Voice AI along with the version and tool count.

## [0.1.1] - 2026-05-22

### Added

- Server identifies itself to MCP clients via an `instructions` field on initialize. The text orients the LLM to which tool surfaces exist, the conventions for pagination, and the authentication setup, so tool selection on the first request is better-informed.

### Changed

- Extracted response trim and redaction helpers to `src/helpers.ts` so they can be unit-tested independently of the generated tool table. `scripts/regen.mjs` now imports them instead of inlining.

### Build

- Added vitest with 18 unit tests covering `redactSensitive`, `findList`, and `trimLargeResponse`. CI gates the publish on tests passing.
- Forced GitHub Actions to run on Node.js 24 to silence the Node.js 20 deprecation warning.

## [0.1.0] - 2026-05-22

### Added

- Initial release.
- 49 tools across agents, calls, bulk calls, knowledge base, phone numbers, providers, simulations, and reseller surfaces.
- Stdio transport for Claude Desktop, Cursor, Windsurf, and other MCP clients.
- Bearer token auth via `OMNIDIM_API_KEY`.
- Response trimming for list endpoints to keep payloads within model context budgets. Single-resource responses pass through unchanged.
- Redaction of `api_key` field values anywhere in any response, so reseller list endpoints can't surface child orgs' plaintext keys to the LLM.
- Pagination input validation: `pageno` and `pagesize` are typed as integer with `minimum: 1`. Invalid values rejected by Zod before any HTTP call.
- HTML-response detection: requests that hit the backend's frontend 404 surface as a clean error rather than dumping HTML.
- Friendly missing-key error when `OMNIDIM_API_KEY` is unset.
- 60-second axios timeout on every backend call.
- `User-Agent: OmniDimension-mcp-server/<version>` on every backend request.
- Cached, scoped Zod schema construction (no `eval`).
- Per-request and per-auth-apply stderr logs gated behind `OMNIDIM_DEBUG=1`.

### Security

- No `dotenv` autoload. `OMNIDIM_API_KEY` must be set via the MCP client's `env` block, never read from `.env` in the caller's working directory.
