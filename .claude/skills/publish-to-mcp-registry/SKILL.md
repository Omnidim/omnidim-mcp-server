---
name: publish-to-mcp-registry
description: >
  Publish @omnidim-ai/mcp-server to the official MCP Registry (registry.modelcontextprotocol.io)
  so directories like PulseMCP ingest it automatically. Use when publishing, submitting, or
  listing the MCP server to the registry, cutting a registry release, or updating server.json.
  Covers the patch-release-for-mcpName requirement, mcp-publisher login and publish, verification,
  and failure modes. Has human-in-the-loop steps (npm OTP, GitHub device flow) where you must
  stop and ask the user.
---

# Publish @omnidim-ai/mcp-server to the official MCP Registry

Agent runbook. Execute from the root of the `omnidim-mcp-server` repo.
Goal: one listing on registry.modelcontextprotocol.io that advertises
both the npm package (stdio) and the hosted remote (mcp.omnidim.io/mcp).
PulseMCP and other directories ingest from this registry automatically.

## Context / current state (as of 2026-06-07)

- `@omnidim-ai/mcp-server` 0.4.0 is live on npm. The repo is public at
  github.com/Omnidim/omnidim-mcp-server.
- `server.json` exists at the repo root (registry manifest, currently
  says version 0.4.0). `glama.json` also exists (Glama, separate
  registry, no action in this task).
- `package.json` has `"mcpName": "io.github.omnidim/omnidim-mcp-server"`
  already added, but the npm-PUBLISHED 0.4.0 tarball does NOT contain
  it. The registry verifies npm ownership by reading `mcpName` from the
  published package, so a patch release is REQUIRED before publishing.
- The hosted remote https://mcp.omnidim.io/mcp is live (OAuth metadata
  at /.well-known/oauth-authorization-server verified working).
- These repo changes may not be committed yet. Check `git status` first.

## Human-in-the-loop points (stop and ask the user)

1. `npm publish` may prompt for an npm OTP (2FA). The user must enter it.
2. `mcp-publisher login github` starts a GitHub device flow: it prints a
   URL (github.com/login/device) and a code. The USER must open the URL
   and enter the code, logged in to the GitHub account that owns the
   `Omnidim` org. Never enter credentials yourself; never paste the code
   anywhere other than github.com/login/device.

## Steps

```bash
# 0. Sanity: confirm clean state and the prepared files
git status
cat server.json
grep mcpName package.json   # must print the io.github.omnidim name

# 1. Commit the prepared files if not yet committed
git add server.json glama.json package.json
git commit -m "Add MCP registry manifests (server.json, glama.json, mcpName)"

# 2. Patch release so the npm tarball carries mcpName
npm version patch            # 0.4.0 -> 0.4.1 (creates commit + tag)
npm publish                  # prepublishOnly runs build + tests; may prompt OTP

# 3. Sync server.json to the released version: update BOTH version
#    fields ("version" at top level and packages[0].version) to match
#    the new version from step 2. Then:
git add server.json
git commit -m "server.json: bump to 0.4.1"
git push && git push --tags

# 4. Install the publisher CLI (pick one)
brew install mcp-publisher
# or: go install github.com/modelcontextprotocol/registry/cmd/publisher@latest

# 5. Authenticate (GitHub device flow - HUMAN STEP, see above)
mcp-publisher login github

# 6. Publish the listing (reads ./server.json)
mcp-publisher publish
```

## Verify

```bash
curl -s "https://registry.modelcontextprotocol.io/v0/servers?search=omnidim"
```

Expect a JSON result containing `io.github.omnidim/omnidim-mcp-server`
with the npm package and the mcp.omnidim.io remote. If found: done.

## Failure modes

- `npm publish` 403: not logged in to npm or no publish rights on the
  @omnidim-ai scope. `npm whoami` to check; user logs in with `npm login`.
- `mcp-publisher publish` ownership error mentioning mcpName: the npm
  tarball doesn't carry the field yet. Confirm step 2 actually published
  (`npm view @omnidim-ai/mcp-server mcpName` should print the name).
- Namespace error on `io.github.omnidim`: the GitHub login used in the
  device flow doesn't control the Omnidim org. Re-login with the right
  account.
- Version mismatch error: server.json versions don't match the npm
  release. Redo step 3.
- If `mcp-publisher` validates the remote and complains about
  mcp.omnidim.io: check the server is up
  (`curl -s https://mcp.omnidim.io/.well-known/oauth-authorization-server`),
  then retry. If it persists, publish with the `remotes` block removed
  as a fallback and re-add it in a follow-up publish, and note this in
  the wrap-up.

## After success

- Update `~/omnidim/_research/ai-visibility-roadmap.md`: mark the
  official-registry submission done (Phase 1, item 3 sub-bullet).
- Update `~/omnidim/REGISTRY_SUBMISSIONS_HANDOFF.md`: check off step 1.
- Remaining (separate, manual, not this task): Smithery sign-in publish,
  Glama claim, mcp.so submit form. PulseMCP needs nothing; it ingests
  this registry within ~a week.
- After PulseMCP/Glama pick it up, rescan https://ora.ai/score/omnidim.io.
