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
- Never publish from a laptop. Tag → CI → npm.

### npm token requirements

The `NPM_TOKEN` secret used by CI **must be a Granular Access Token**, not a Classic Automation token. Reason: since 2024, npm requires 2FA OTP on publish even when authenticating with an Automation token. Granular tokens have a per-token "bypass 2FA on publish" setting that an Automation token lacks. Symptom of using the wrong token type: CI publish fails with `npm error code EOTP — This operation requires a one-time password`.

Generate the token at `https://www.npmjs.com/settings/<username>/tokens` → Generate New Token → Granular Access Token → scope it to the `@omnidim-ai` org with Read and Write permissions.

## Changelog discipline

Every release gets an entry in `CHANGELOG.md` before its tag is pushed.

- Format: Keep a Changelog. Sections are `### Added`, `### Changed`, `### Fixed`, `### Removed`, `### Security` as needed.
- The `[Unreleased]` section collects entries as work lands on `main`. When tagging `vX.Y.Z`, rename that section to `[X.Y.Z] - YYYY-MM-DD` and start a fresh `[Unreleased]` above it.
- **Diff against what's on npm, not against the last local checkpoint.** The entry describes what changes for a customer upgrading from the previous published version to this one. WIP iterations between tags (re-tries, design changes that never shipped, debug logs that were added and removed) do not appear in the changelog.
- Entries describe user-visible behaviour, not commit-by-commit history. Group related commits into a single bullet.
- Breaking changes go under `### Changed` with a **BREAKING** prefix and a migration note.
- Security fixes belong in `### Security` with a CVE reference if one exists.
- If a tag goes out without a clean entry, that's a release process bug — edit the GitHub Release notes after the fact and fix the local CHANGELOG.md for future tags.

## Commits

- Conventional commit prefixes: `feat`, `fix`, `chore`, `docs`, `ci`, `build`, `test`, `refactor`.
- Single line. No body unless the change really needs one.
- No `Co-Authored-By` footer.
- Never run `git commit` without explicit user permission. Stage and summarise first, wait for the word "commit".
