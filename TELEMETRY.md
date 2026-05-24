# Telemetry

`@omnidim-ai/mcp-server` collects anonymous usage data to help us improve the package. This page lists exactly what is and isn't sent, so what we say matches what we do.

## What is sent

Three event types, each posted to `https://mcp.omnidim.io/api/telemetry/event` as a JSON POST.

### `install` (once, after `npx ... setup` completes)

```json
{
  "event": "install",
  "install_id": "5f3a8c2d-1b94-...",
  "package": "@omnidim-ai/mcp-server",
  "package_version": "0.2.6",
  "node_version": "v20.18.0",
  "os_platform": "darwin",
  "os_arch": "arm64"
}
```

### `session_start` (every server boot)

```json
{
  "event": "session_start",
  "install_id": "5f3a8c2d-1b94-...",
  "package": "@omnidim-ai/mcp-server",
  "package_version": "0.2.6",
  "node_version": "v20.18.0",
  "os_platform": "darwin",
  "os_arch": "arm64"
}
```

### `session_end` (graceful shutdown)

```json
{
  "event": "session_end",
  "install_id": "5f3a8c2d-1b94-...",
  "package": "@omnidim-ai/mcp-server",
  "package_version": "0.2.6",
  "node_version": "v20.18.0",
  "os_platform": "darwin",
  "os_arch": "arm64",
  "duration_s": 245,
  "tools_called": [
    { "tool": "listAgents", "count": 12 },
    { "tool": "dispatchCall", "count": 3 }
  ]
}
```

## What is NOT sent

- **No IP address.** We do not read or attach client IP.
- **No hostname.** We never call `os.hostname()`.
- **No username or file paths.** The install id file is read for the UUID only.
- **No API key, OAuth token, or credentials.** The telemetry endpoint has no auth header.
- **No tool inputs or outputs.** Only the tool *name* and an aggregated *count* per session.
- **No exact OS version, kernel build, or CPU model.** Only family (`darwin`/`linux`/`win32`) and arch (`x64`/`arm64`).
- **No marketing analytics SDKs.** Pure HTTP POST. No fingerprinting library, no cookies.

## How to disable

Any of these will silence telemetry permanently:

```bash
# Subcommand (recommended)
npx -y @omnidim-ai/mcp-server telemetry disable

# Standard environment variable (W3C)
export DO_NOT_TRACK=1

# Project-specific environment variable
export OMNIDIM_TELEMETRY=0
```

Re-enable with `npx -y @omnidim-ai/mcp-server telemetry enable`, or unset the env var. Check current state with `npx -y @omnidim-ai/mcp-server telemetry status`.

When disabled, no events are sent, period. There is no "we still ping once to mark them as opted out" loophole — the request is never built.

## Where the data goes

Events are received by `mcp.omnidim.io` and written to our private observability stack (Loki + Grafana). Retention is bounded to seven days. The data is used to:

- Understand active-install vs npm-download ratio
- Drive support decisions (which Node versions to maintain, which OSes to test)
- Spot crash signatures via missing `session_end` after `session_start`

It is not shared with third parties, sold, or used for advertising.

## The install id

A random UUID generated on first use, stored at `~/.config/omnidim/install-id` (mode 0600, owner-readable only). It is not derived from your machine, username, or any identifier — it's pure randomness. Delete the file at any time to roll your installation identifier; the next event will generate a fresh one.

## Source

The collection code is open source at `src/telemetry.ts` in this repository. If you spot any discrepancy between this document and the code, open an issue or email `security@omnidim.io`.
