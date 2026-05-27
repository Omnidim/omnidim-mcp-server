# CLAUDE.md — omnidim-mcp-server

Guidance for working on `@omnidim-ai/mcp-server`.

## What this repo is

The npm-distributed Model Context Protocol server for OmniDimension. Users install it with `npx @omnidim-ai/mcp-server` and run it locally over stdio. It calls `https://backend.omnidim.io/api/v1` with a bearer token from `OMNIDIM_API_KEY`.

## Build, test, inspect

- `npm run build` — compile TypeScript to `build/`.
- `npm test` — run the vitest suite.
- `npm run typecheck` — `tsc --noEmit`.
- `OMNIDIM_API_KEY=sk_... npm run inspect` — drive the tools interactively via MCP Inspector.

## Conventions

- **Every behaviour change ships with a test.** typecheck, build, and tests gate every commit and every published release.
- **`src/index.ts` is generated** from the OpenAPI spec via `npm run regen` and is overwritten on regeneration. Keep customisations as patches in `scripts/regen.mjs`, never as hand-edits to `src/index.ts`, and add a test for any patched behaviour.
- **No marketing copy** in user-facing strings (README, error messages, `.env.example`), and no em dashes in user-visible text.
- **Comments only when the "why" is non-obvious.** One line.
- **Commits:** conventional prefixes (`feat`, `fix`, `chore`, `docs`, `ci`, `build`, `test`, `refactor`), single line.
- **User-facing URLs must be real:** API keys at `https://omnidim.io/api-management`, authentication docs at `https://docs.omnidim.io/docs/get-started/authentication`.

## Changelog

`CHANGELOG.md` follows [Keep a Changelog](https://keepachangelog.com/). Entries describe user-visible behaviour (not commit history, not test or CI work), grouped under `Added` / `Changed` / `Fixed` / `Removed` / `Security`. The `[Unreleased]` section collects changes and is renamed to `[X.Y.Z] - YYYY-MM-DD` at release. Releases are cut by maintainers via a `v*` tag, which CI publishes.
