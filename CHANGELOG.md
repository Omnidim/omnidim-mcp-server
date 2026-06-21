# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- MCP prompts and resources. A `provision_agent` prompt walks a client through creating a working voice agent end to end (configure, attach a number, verify it can place a call and speak), and an `omnidim://guide/routing` resource documents which tool to call when and the rules that are easy to get wrong.

### Security

- The API base URL is pinned to production and can no longer be overridden by the `API_BASE_URL` environment variable, so the bearer key is never sent to a different host.

## [0.5.1] - 2026-06-19

### Fixed

- Avoid check-then-act file races when trimming the log file and reading the install id.

### Changed

- The type-regeneration script fetches the spec from the public docs site, so it runs from a clean checkout.
- Updated dependencies (axios and dev tooling).

## [0.5.0] - 2026-06-11

### Changed

- Simulation tools are removed from the catalogue.
- Model and voice provider options match the live catalog, so current models are selectable and stale entries are gone.
- Voice selection documents that `voice_id` is the `name` value from the voices list, and language names follow the dashboard's language picker.
- Server instructions explain how an outbound call picks the number it is placed from.

## [0.4.2] - 2026-06-07

### Fixed

- MCP Registry name corrected to `io.github.Omnidim/omnidim-mcp-server` (capital O, matching the GitHub org login).

## [0.4.1] - 2026-06-07

### Added

- Listed on the official MCP Registry as `io.github.omnidim/omnidim-mcp-server`, covering both this npm package and the hosted server at `mcp.omnidim.io`.

## [0.4.0] - 2026-05-27

### Added

- `doctor` command (`npx -y @omnidim-ai/mcp-server doctor`) that prints a paste-ready diagnostics report — package/Node/OS versions, detected MCP clients, backend reachability, and recent errors — for bug reports. It never prints your API key.
- A local diagnostics log at `~/.config/omnidim/logs/mcp.log` recording tool-call errors, setup failures, and crashes. It stays on your machine, is never transmitted, and redacts anything token-shaped.

## [0.3.1] - 2026-05-27

### Added

- `setup` now detects and installs for VS Code, alongside Claude Code, Claude Desktop, Cursor, and Windsurf.
- `setup` resolves the correct config path per operating system (macOS, Windows, Linux).
- `setup` shows the OmniDimension wordmark on wide terminals, falling back to a compact banner on narrow ones.

### Fixed

- `setup` now detects an installed app directly and creates its MCP config file if one doesn't exist yet. Previously it only configured clients that already had a config file, so Claude Desktop was skipped on a machine that had never set up an MCP server before.
- `setup` treats an empty or whitespace-only client config file as a fresh config instead of failing with "Unexpected end of JSON input".

### Changed

- Anonymous telemetry now records setup-step and crash outcomes as short error *categories* (e.g. `config_write_error`, `http_500`), never error messages or file paths, so failed installs and tool calls are diagnosable. Full field list in [TELEMETRY.md](./TELEMETRY.md).

## [0.2.9] - 2026-05-25

### Changed

- `setup` detects a saved key at `~/.config/omnidim/credentials`, validates it, and offers to reuse instead of asking again every time.

### Fixed

- `claude mcp remove omnidim` now passes `--scope user` to match the scope `claude mcp add` uses, preventing the "already exists in user config" error on re-running setup.

## [0.2.8] - 2026-05-25

### Changed

- Telemetry consent line now shows the `npx -y @omnidim-ai/mcp-server` form so users can copy-paste the exact command they'd run.

## [0.2.7] - 2026-05-25

### Added

- Anonymous usage telemetry: `install`, `session_start`, `session_end` events with package version, Node version, OS family + arch, and per-tool counts. Full field list in [TELEMETRY.md](./TELEMETRY.md).
- `omnidim-mcp-server telemetry {enable | disable | status}` subcommand. `DO_NOT_TRACK=1` and `OMNIDIM_TELEMETRY=0` are also respected silently.

## [0.2.5] - 2026-05-23

### Changed

- `setup` masks the API key as you type or paste it. Each character renders as `*` so the key never appears in terminal scrollback.

## [0.2.4] - 2026-05-23

### Added

- A small rotating closing line at the end of `setup`, shown in faded italic. Picked from a short curated list each run.

## [0.2.3] - 2026-05-23

### Fixed

- Auto-install for Claude Code. The server name was placed after the `-e` flag, which made Claude Code's CLI parser treat it as a second env-var value (`Invalid environment variable format: omnidim`). Name is now passed immediately after `mcp add`, before any flags, so the variadic `-e` no longer swallows it.

## [0.2.2] - 2026-05-23

### Changed

- `setup` shows the real error from `claude mcp add` when the install step fails, and prints the exact manual command to run instead. Previously the failure surfaced as a generic "Command failed" line.
- Dropped the "restart your MCP client" trailing line. The setup runs in its own terminal; the next time the user opens their MCP client they will pick up the new server.

## [0.2.1] - 2026-05-23

### Fixed

- `setup` subcommand is now wired into the binary entrypoint. In 0.2.0 the regeneration pipeline silently skipped the wiring patch and `npx -y @omnidim-ai/mcp-server setup` fell through to the help screen instead of running the interactive flow.

## [0.2.0] - 2026-05-23

### Added

- `npx @omnidim-ai/mcp-server setup` interactive command. Prompts for an API key, validates it against the OmniDimension API, saves it to `~/.config/omnidim/credentials` (mode 0600), then offers to install the server in any detected MCP client (Claude Code, Claude Desktop, Cursor, Windsurf).
- Credentials file fallback. The server now reads the API key from `~/.config/omnidim/credentials` when `OMNIDIM_API_KEY` is not set in the env block, so customers no longer need to paste a key into every client's config separately.

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
