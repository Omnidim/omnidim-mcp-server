# CLAUDE.md — omnidim-mcp-server

Guidance for working on `@omnidim-ai/mcp-server`.

## What this repo is

The npm-distributed Model Context Protocol server for OmniDimension. Users install it with `npx @omnidim-ai/mcp-server` and run it locally over stdio. It calls `https://omnidim.io/api/v1` with a bearer token from `OMNIDIM_API_KEY`.

## Build, test, inspect

- `npm run build` — compile TypeScript to `build/`.
- `npm test` — run the vitest suite.
- `npm run typecheck` — `tsc --noEmit`.
- `OMNIDIM_API_KEY=sk_... npm run inspect` — drive the tools interactively via MCP Inspector.

## Conventions

- **Every behaviour change ships with a test.** typecheck, build, and tests gate every commit and every published release.
- **`src/index.ts` is generated** from the OpenAPI spec via `npm run regen` and is overwritten on regeneration. Keep customisations as patches in `scripts/regen.mjs`, never as hand-edits to `src/index.ts`, and add a test for any patched behaviour.
- **Merge tools in the spec, not here.** To serve several operations as one tool with an `action` field, add `merge: {tool, action}` to their `x-mcp` blocks and a `x-mcp-tools` entry in the omnidim-docs spec. Regen folds them (`scripts/x-mcp.mjs` `mergePlan`, `src/merged-tools.ts`) with no code change here. omnidim-mcp-cloud applies the same rules, so change both together.
- **No marketing copy** in user-facing strings (README, error messages, `.env.example`), and no em dashes in user-visible text.
- **Comments only when the "why" is non-obvious.** One line.
- **Commits:** conventional prefixes (`feat`, `fix`, `chore`, `docs`, `ci`, `build`, `test`, `refactor`), single line.
- **User-facing URLs must be real:** API keys at `https://omnidim.io/api-management`, authentication docs at `https://docs.omnidim.io/docs/get-started/authentication`.

## Changelog

Do not edit `CHANGELOG.md` or any version number by hand. release-please writes both from PR titles.

- PRs are squash-merged, so the PR title becomes the commit and the changelog line. Write it as a conventional commit that a user can read: `feat: ...` lands under Added, `fix: ...` under Fixed, `perf: ...` under Changed. `ci`, `test`, `build`, `docs` and `chore` stay out of the changelog. The `pr-title` check rejects other formats.
- After each merge to `main`, release-please updates one open release PR with the next version and changelog. Merging it tags the release, publishes to npm, and updates the MCP Registry. A member of the maintainers team (Ryu, Kevin) approves and merges it.
