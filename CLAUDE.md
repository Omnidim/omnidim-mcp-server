# CLAUDE.md — omnidim-mcp-server

Repo-specific rules for working on `@omnidim-ai/mcp-server`. Global rules in `~/.claude/CLAUDE.md` and workspace rules in `/Users/ryu/omnidim/CLAUDE.md` apply on top.

## What this repo is

The npm-distributed MCP server. Customers install it via `npx @omnidim-ai/mcp-server` and run it locally on their machine (stdio transport). It talks to `backend.omnidim.io/api/v1` with a bearer token from `OMNIDIM_API_KEY`. Sibling repo `omnidim-mcp-cloud` is the hosted variant; do not conflate the two.

## Test policy

**Every new feature ships with a test.** No exceptions. The CI gate is non-negotiable: ruff + typecheck + every test must pass before any commit reaches `main`, and before any tag triggers an npm publish.

- Tests live in a `tests/` directory (to be added — currently only one smoke test exists for the generator output).
- Defaults already in CI: `npm run typecheck`, build. Add `npm test` once the test runner is wired.
- When changing `scripts/regen.mjs` or anything that touches the generated `src/index.ts`, add or update a test that exercises the patched behavior so a future regen can't silently revert the customization.
- "Manual smoke via MCP Inspector" does not count as a test. If a behavior is worth keeping, it has a test.

## URLs and copy that ship to users

This package is public-facing. Customers read its README, error messages, and `.env.example`. Verify every external URL or instruction against actual product surfaces before writing it:

- API key management page: `https://omnidim.io/api-management` (NOT `/settings/api-keys`).
- Authentication docs: `https://docs.omnidim.io/docs/get-started/authentication`.
- Backend API base: `https://backend.omnidim.io/api/v1`.

When in doubt, grep the dashboard repo (`omni-dashboard-new/app`) or the docs repo (`omnidim-docs/content`) for the canonical path. Never invent.

## Code hygiene

- Code generated from the OpenAPI spec lives in `src/index.ts`. It is overwritten by `npm run regen`. Customisations are re-applied by `scripts/regen.mjs`. If a behaviour must survive regeneration, the patch lives in that script, not as a hand-edit to `src/index.ts`.
- No marketing copy in user-facing strings. No "preserved", "intelligent", "powerful", em dashes, or fluff in commit messages, README copy, or in-code error messages.
- Comments only when the "why" is non-obvious. Single line if at all.

## Release flow

- `main` is the release branch. Every commit on `main` must build and pass tests in CI.
- Production publishes on a `v*` git tag (e.g. `v0.1.0`). The CI workflow runs `npm publish --provenance --access public`.
- Staging publishes (when configured) go to a `next` dist-tag for pre-release validation.
- Never publish from a laptop. Tag → CI → npm.

## Commits

- Conventional commit prefixes: `feat`, `fix`, `chore`, `docs`, `ci`, `build`, `test`, `refactor`.
- Single line. No body unless the change really needs one.
- No `Co-Authored-By` footer.
- Never run `git commit` without explicit user permission. Stage and summarise first, wait for the word "commit".
