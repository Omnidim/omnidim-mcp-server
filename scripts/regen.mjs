#!/usr/bin/env node
/**
 * Regenerate src/index.ts from the OmniDimension OpenAPI spec.
 *
 * Generates into a temp directory so the generator doesn't trample
 * customized files (package.json, tsconfig, .gitignore, LICENSE, etc.),
 * then copies src/index.ts back and re-applies the defensive patches
 * documented inline below.
 *
 * Usage:
 *   npm run regen
 *   SPEC=path/to/omnidim.yaml node scripts/regen.mjs
 */
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync, mkdtempSync, copyFileSync, rmSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import yaml from 'js-yaml';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');

// The spec is fetched from the published docs site so regen runs from a
// clean checkout. Set SPEC to a local file to override.
const SPEC_URL = 'https://docs.omnidim.io/openapi.yaml';
const SPEC_OVERRIDE = process.env.SPEC ? resolve(process.env.SPEC) : null;
const DEFAULT_CONFIG = resolve(ROOT, 'mcp-config.yaml');
const CONFIG = process.env.MCP_CONFIG ? resolve(process.env.MCP_CONFIG) : DEFAULT_CONFIG;

async function loadSpecBytes() {
  if (SPEC_OVERRIDE) {
    if (!existsSync(SPEC_OVERRIDE)) {
      console.error(`spec not found: ${SPEC_OVERRIDE}`);
      process.exit(1);
    }
    return { bytes: readFileSync(SPEC_OVERRIDE), label: SPEC_OVERRIDE };
  }
  const res = await fetch(SPEC_URL);
  if (!res.ok) {
    console.error(`failed to fetch spec: ${res.status} ${SPEC_URL}`);
    process.exit(1);
  }
  return { bytes: Buffer.from(await res.arrayBuffer()), label: SPEC_URL };
}

const { bytes: specBytes, label: specLabel } = await loadSpecBytes();

const pkg = JSON.parse(readFileSync(resolve(ROOT, 'package.json'), 'utf8'));
const TMP = mkdtempSync(join(tmpdir(), 'omnidim-mcp-regen-'));

console.log(`regenerating from ${specLabel}`);
console.log(`tmp output: ${TMP}`);

// Drop endpoints the shared MCP exposure config excludes, before the
// generator runs, so excluded operations never become tools.
const METHODS = ['get', 'post', 'put', 'patch', 'delete'];
const excludeCfg = existsSync(CONFIG)
  ? (yaml.load(readFileSync(CONFIG, 'utf8'))?.exclude ?? {})
  : {};
const excludedPaths = new Set(excludeCfg.paths ?? []);
const excludedOps = new Set(excludeCfg.operation_ids ?? []);
const spec = yaml.load(specBytes.toString('utf8'));
let removed = 0;
for (const [specPath, item] of Object.entries(spec.paths ?? {})) {
  if (excludedPaths.has(specPath)) {
    delete spec.paths[specPath];
    removed += METHODS.filter((m) => item[m]).length;
    continue;
  }
  for (const m of METHODS) {
    if (item[m] && excludedOps.has(item[m].operationId)) {
      delete item[m];
      removed += 1;
    }
  }
  if (!METHODS.some((m) => item[m])) delete spec.paths[specPath];
}
const FILTERED_SPEC = `${TMP}-filtered-spec.yaml`;
writeFileSync(FILTERED_SPEC, yaml.dump(spec, { noRefs: true }));
console.log(`excluded ${removed} operations via ${CONFIG}`);

const result = spawnSync(
  'npx',
  [
    '-y',
    'openapi-mcp-generator@latest',
    '--input', FILTERED_SPEC,
    '--output', TMP,
    '--server-name', pkg.name,
    '--server-version', pkg.version,
    '--base-url', 'https://backend.omnidim.io/api/v1',
    '--transport', 'stdio',
    '--force',
  ],
  { stdio: 'inherit' }
);
if (result.status !== 0) {
  rmSync(TMP, { recursive: true, force: true });
  rmSync(FILTERED_SPEC, { force: true });
  process.exit(result.status ?? 1);
}

const indexPath = resolve(ROOT, 'src/index.ts');
copyFileSync(join(TMP, 'src/index.ts'), indexPath);
rmSync(TMP, { recursive: true, force: true });
rmSync(FILTERED_SPEC, { force: true });

let src = readFileSync(indexPath, 'utf8');

// Replace the generator's banner comment. Uses [\s\S]*? rather than
// [^*]* because the banner is multi-line and intermediate ` * ` lines
// would otherwise break the negated-character-class match.
src = src.replace(
  /\/\*\*\s*\n \* MCP Server generated from OpenAPI spec[\s\S]*?\*\//,
  '/**\n * OmniDimension MCP server.\n */'
);

src = src.replace(
  /export const SERVER_NAME = ".*?";/,
  'export const SERVER_NAME = "OmniDimension";'
);

// Drop the dotenv autoload. MCP convention is for the client to pass
// env vars in its config block; loading .env from the caller's CWD
// vacuums in credentials from unrelated projects.
src = src.replace(
  /\/\/ Load environment variables from \.env file\nimport dotenv from 'dotenv';\ndotenv\.config\(\);\n\n/,
  ''
);

// Pin the backend to production. The base URL never changes, and an
// env-overridable base URL is a credential-exfiltration surface: the
// server attaches the user's bearer key to every request to whatever
// the URL points at. No override, no startup log.
src = src.replace(
  /\/\/ Base URL for the API, can be set via environment variable or determined from OpenAPI spec\nexport const API_BASE_URL = process\.env\.API_BASE_URL \|\| "https:\/\/backend\.omnidim\.io\/api\/v1";\nconsole\.error\("API_BASE_URL is set to:", API_BASE_URL\);/,
  `// Base URL for the API. Pinned to production; not env-overridable.
export const API_BASE_URL = "https://backend.omnidim.io/api/v1";`
);

// Add User-Agent + 60s timeout to every backend request.
src = src.replace(
  /\/\/ Prepare the axios request configuration\n\s+const config: AxiosRequestConfig = \{\n\s+method: definition\.method\.toUpperCase\(\),\s*\n\s+url: requestUrl,\s*\n\s+params: queryParams,\s*\n\s+headers: headers,\n\s+\.\.\.\(requestBodyData !== undefined && \{ data: requestBodyData \}\),\n\s+\};/,
  `// Prepare the axios request configuration
    headers['user-agent'] = \`\${SERVER_NAME}-mcp-server/\${SERVER_VERSION}\`;
    const config: AxiosRequestConfig = {
      method: definition.method.toUpperCase(),
      url: requestUrl,
      params: queryParams,
      headers: headers,
      timeout: 60_000,
      ...(requestBodyData !== undefined && { data: requestBodyData }),
    };`
);

// Replace eval() with a scoped new Function + per-tool cache. The schema
// string is compile-time generated from inputSchema literals (never user
// input), but shipping eval to npm is a footgun and an auditor flag.
src = src.replace(
  /function getZodSchemaFromJsonSchema\(jsonSchema: any, toolName: string\): z\.ZodTypeAny \{[\s\S]*?\n\}\n/,
  `const zodSchemaCache: Map<string, z.ZodTypeAny> = new Map();
function getZodSchemaFromJsonSchema(jsonSchema: any, toolName: string): z.ZodTypeAny {
    const cached = zodSchemaCache.get(toolName);
    if (cached) return cached;
    if (typeof jsonSchema !== 'object' || jsonSchema === null) {
        const fallback = z.object({}).passthrough();
        zodSchemaCache.set(toolName, fallback);
        return fallback;
    }
    try {
        const body = jsonSchemaToZod(jsonSchema);
        const factory = new Function('z', \`return (\${body});\`) as (z: any) => z.ZodTypeAny;
        const schema = factory(z);
        if (typeof (schema as any)?.parse !== 'function') {
            throw new Error('Schema factory did not produce a valid Zod schema.');
        }
        zodSchemaCache.set(toolName, schema);
        return schema;
    } catch (err: any) {
        console.error(\`Failed to generate Zod schema for '\${toolName}':\`, err);
        const fallback = z.object({}).passthrough();
        zodSchemaCache.set(toolName, fallback);
        return fallback;
    }
}
`
);

// Read bearer token from OMNIDIM_API_KEY (matches the Python SDK
// convention), falling back to the generator's auto-named env var.
src = src.replaceAll(
  /return !!process\.env\[`BEARER_TOKEN_\$\{schemeName\.replace\(\/\[\^a-zA-Z0-9\]\/g, '_'\)\.toUpperCase\(\)\}`\];/g,
  `return !!(process.env.OMNIDIM_API_KEY || process.env[\`BEARER_TOKEN_\${schemeName.replace(/[^a-zA-Z0-9]/g, '_').toUpperCase()}\`]);`
);
src = src.replaceAll(
  /const token = process\.env\[`BEARER_TOKEN_\$\{schemeName\.replace\(\/\[\^a-zA-Z0-9\]\/g, '_'\)\.toUpperCase\(\)\}`\];/g,
  `const token = process.env.OMNIDIM_API_KEY || process.env[\`BEARER_TOKEN_\${schemeName.replace(/[^a-zA-Z0-9]/g, '_').toUpperCase()}\`];`
);

// axios v1 typed response.headers as a union; the generator's call to
// `.toLowerCase()` on it fails strict TS.
src = src.replace(
  "const contentType = response.headers['content-type']?.toLowerCase() || '';",
  "const contentType = String(response.headers['content-type'] ?? '').toLowerCase();"
);

// Import the trim/redact helpers from a hand-maintained module so they
// stay testable and aren't overwritten by regeneration.
const bannerAnchor = '/**\n * OmniDimension MCP server.\n */';
if (!src.includes(bannerAnchor)) {
  console.error(`banner anchor missing — generator output shape changed; investigate before re-running`);
  process.exit(2);
}
src = src.replace(
  bannerAnchor,
  `${bannerAnchor}\nimport { readApiKey } from "./credentials.js";\nimport { isInteractive, printInteractiveHelp, startupBanner, trimLargeResponse } from "./helpers.js";\nimport { beginSession, emitSessionCrash, emitSessionEnd, endSession, recordToolError, recordToolResult } from "./telemetry.js";\nimport { registerProcedures } from "./procedures.js";\nimport { notifyUpdates } from "./update_notifier.js";\n`
);

// Fall back to the saved credentials file when neither OMNIDIM_API_KEY
// nor BEARER_TOKEN_<scheme> is set in the environment.
src = src.replaceAll(
  "process.env.OMNIDIM_API_KEY || process.env[`BEARER_TOKEN_",
  "process.env.OMNIDIM_API_KEY || readApiKey() || process.env[`BEARER_TOKEN_"
);

// Add an instructions block to the MCP initialize response. The text
// orients the LLM client to what this server does before any tool call.
const INSTRUCTIONS_BLOCK = `const SERVER_INSTRUCTIONS = \`OmniDimension is a voice AI platform. This server exposes tools for managing voice agents and call infrastructure.

Surfaces:
- Agents: create, list, get, update, delete voice agents (transcriber, LLM, voice, post-call actions, transfer rules, dynamic-variable templating).
- Calls: dispatchCall for a single outbound call, listCallLogs and getCallLog for history and transcripts.
- Bulk calls: campaign management with scheduling, retry, and live status.
- Knowledge base: upload PDFs and attach to agents.
- Phone numbers: list, attach to agents, import from Twilio, Exotel, or SIP.
- Providers: discover available LLMs, voices, STT, and TTS engines.
- Reseller: child organization management (requires partner-level credentials; non-reseller keys get 403).

Conventions:
- List endpoints accept pageno (>= 1) and pagesize (1-150). Use name to filter.
- For details on one item, call get<Resource>(id) after listing.
- Dispatching calls: run listPhoneNumbers first. If the account has numbers, pass the chosen one as from_number_id. If it has none, omit from_number_id and the platform's default number is used. Never guess a from_number_id.
- Configure OMNIDIM_API_KEY in your MCP client config to authenticate.
- API reference: https://docs.omnidim.io\`;

`;
src = src.replace(
  /const server = new Server\(\s*\{ name: SERVER_NAME, version: SERVER_VERSION \},\s*\{ capabilities: \{ tools: \{\} \} \}\s*\);/,
  `${INSTRUCTIONS_BLOCK}const server = new Server(
    { name: SERVER_NAME, version: SERVER_VERSION },
    { capabilities: { tools: {}, prompts: {}, resources: {} }, instructions: SERVER_INSTRUCTIONS }
);

// Prompts (procedures) and resources (reference) layered on top of the tools.
registerProcedures(server);`
);

// Route JSON responses through the trimmer.
src = src.replace(
  /try \{\s*\n\s*responseText = JSON\.stringify\(response\.data, null, 2\);\s*\n\s*\} catch \(e\) \{/,
  `try {
             const trimmed = trimLargeResponse(response.data);
             responseText = trimmed.text;
             if (trimmed.note) responseText += \`\\n\\n\${trimmed.note}\`;
         } catch (e) {`
);

// Make pagination params strict (integer ≥1) so invalid values are
// rejected by Zod before reaching the backend (which 500s on them).
src = src.replaceAll('"pageno":{"type":"number"', '"pageno":{"type":"integer","minimum":1');
src = src.replaceAll('"pagesize":{"type":"number"', '"pagesize":{"type":"integer","minimum":1');
src = src.replaceAll('"page":{"type":"number","default":1', '"page":{"type":"integer","minimum":1,"default":1');
src = src.replaceAll('"page_size":{"type":"number","default":30', '"page_size":{"type":"integer","minimum":1,"default":30');

// Replace the "no credentials" warning-and-continue branch with an
// early return so the model sees a helpful instruction, not a 401.
// Anchored on the comment marker through the 4-space-indented closing
// brace of the else-if, which is the only `}` at that indent level
// inside this stretch of generator output.
src = src.replace(
  / {4}\/\/ Log warning if security is required but not available\n[\s\S]*?\n {4}\}\n/,
  `    else if (definition.securityRequirements?.length > 0) {
        recordToolResult(toolName, 'no_api_key');
        return {
            content: [{
                type: 'text',
                text: \`OMNIDIM_API_KEY is not set. Configure it in your MCP client's "env" block, then restart the client. Get a key at https://omnidim.io/api-management.\`,
            }],
        };
    }
`
);

// Insert the setup subcommand and TTY-detection branches at the top of
// main(). One patch so neither branch can race the other's anchor.
src = src.replace(
  /(async function main\(\) \{\s*\n)\/\/ Set up stdio transport\s*\n(\s*try \{)/,
  `$1  if (process.argv[2] === "setup") {
    const { runSetup } = await import("./setup.js");
    process.exit(await runSetup());
  }
  if (process.argv[2] === "telemetry") {
    const { runTelemetryCommand } = await import("./telemetry-cli.js");
    process.exit(await runTelemetryCommand(process.argv[3]));
  }
  if (process.argv[2] === "doctor") {
    const { runDoctor } = await import("./doctor.js");
    process.exit(await runDoctor());
  }
  if (isInteractive()) {
    printInteractiveHelp(SERVER_VERSION);
    process.exit(0);
  }
$2`
);

// Replace the bare console.error startup line with a branded banner.
// Line-anchored to avoid the nested-backtick parse problem.
src = src.replace(
  /^.*console\.error\(`\$\{SERVER_NAME\} MCP Server.*$/m,
  `    console.error(startupBanner(SERVER_VERSION, toolDefinitionMap.size));\n    beginSession();\n    notifyUpdates(SERVER_VERSION);`
);

// Flush the session-end event during graceful shutdown, before the generator's
// console.error + process.exit. Best-effort: telemetry must never block shutdown.
src = src.replace(
  /async function cleanup\(\) \{\s*\n\s*console\.error\("Shutting down MCP server\.\.\.\"\);\s*\n\s*process\.exit\(0\);\s*\n\}/,
  `async function cleanup() {
    try {
        await emitSessionEnd(endSession());
    } catch {
        // telemetry must never block shutdown
    }
    console.error("Shutting down MCP server...");
    process.exit(0);
}`
);

// Gate the per-request log behind OMNIDIM_DEBUG.
src = src.replace(
  /\/\/ Log request info to stderr \(doesn't affect MCP output\)\s*\n\s+console\.error\(`Executing tool "\$\{toolName\}": \$\{config\.method\} \$\{config\.url\}`\);/,
  `if (process.env.OMNIDIM_DEBUG) {
        console.error(\`Executing tool "\${toolName}": \${config.method} \${config.url}\`);
    }`
);

// Gate the "Applied <auth>" stderr lines behind OMNIDIM_DEBUG.
for (const phrase of ['Applied API key', 'Applied Bearer token', 'Applied Basic authentication', 'Applied OAuth2 token', 'Applied OpenID Connect token']) {
  src = src.replaceAll(
    `console.error(\`${phrase}`,
    `if (process.env.OMNIDIM_DEBUG) console.error(\`${phrase}`
  );
}

// Surface HTML responses (Odoo's frontend 404 page on bad path converters)
// as a clean error instead of dumping the HTML body at the model.
src = src.replace(
  /\/\/ Handle string responses\s*\n\s+else if \(typeof response\.data === 'string'\) \{\s*\n\s+responseText = response\.data;\s*\n\s+\}/,
  `// The backend returns an HTML 404 page (not JSON) when a path
    // converter rejects an input (e.g. GET /agents/abc).
    else if (contentType.includes('text/html')) {
         const title = typeof response.data === 'string'
             ? (response.data.match(/<title>([^<]*)<\\/title>/i)?.[1]?.trim() ?? 'HTML response')
             : 'HTML response';
         responseText = \`Upstream returned HTML instead of JSON (HTTP \${response.status}: "\${title}"). The path or method is likely wrong.\`;
    }
    else if (typeof response.data === 'string') {
         responseText = response.data;
    }`
);

// Record a per-tool outcome for the session summary at each result branch:
// validation reject, missing key, success, and the catch-all error path.
// Categories only (never inputs/outputs) so telemetry stays free of PII.
src = src.replace(
  /(\} catch \(error: unknown\) \{\n)(\s*if \(error instanceof ZodError\) \{)/,
  `$1        recordToolResult(toolName, 'validation');\n$2`
);
src = src.replace(
  /(\/\/ Return formatted response\n\s*)(return \{)/,
  `$1recordToolResult(toolName, 'ok');\n    $2`
);
src = src.replace(
  /(\} catch \(error: unknown\) \{\n)(\s*\/\/ Handle errors during execution)/,
  `$1    recordToolError(toolName, error);\n$2`
);

// A crash never runs the graceful-shutdown path, so flush a session_crash
// (carrying the session's tool-call summary) from every uncaught exit.
src = src.replace(
  /(\} catch \(error\) \{\n)(\s*console\.error\("Error during server startup:", error\);)/,
  `$1    try { await emitSessionCrash(error); } catch { /* telemetry must never mask the crash */ }\n$2`
);
src = src.replace(
  /process\.on\('SIGTERM', cleanup\);\n/,
  `process.on('SIGTERM', cleanup);

process.on('uncaughtException', async (error) => {
    try { await emitSessionCrash(error); } catch { /* never mask the crash */ }
    console.error("Uncaught exception:", error);
    process.exit(1);
});
process.on('unhandledRejection', async (reason) => {
    try { await emitSessionCrash(reason); } catch { /* never mask the crash */ }
    console.error("Unhandled rejection:", reason);
    process.exit(1);
});
`
);
src = src.replace(
  /main\(\)\.catch\(\(error\) => \{\n  console\.error\("Fatal error in main execution:", error\);\n  process\.exit\(1\);\n\}\);/,
  `main().catch(async (error) => {
  try { await emitSessionCrash(error); } catch { /* never mask the crash */ }
  console.error("Fatal error in main execution:", error);
  process.exit(1);
});`
);

writeFileSync(indexPath, src);

const specHash = createHash('sha256').update(specBytes).digest('hex');
const configHash = existsSync(CONFIG)
  ? createHash('sha256').update(readFileSync(CONFIG)).digest('hex')
  : 'none';
const endpoints = (src.match(/^  \["/gm) ?? []).length;
const specYml = `openapi_spec_url: https://docs.omnidim.io/openapi.yaml
openapi_spec_hash: ${specHash}
mcp_config_hash: ${configHash}
configured_endpoints: ${endpoints}
generator: openapi-mcp-generator
`;
writeFileSync(resolve(ROOT, '.spec.yml'), specYml);

console.log(`done. ${endpoints} endpoints. spec hash ${specHash.slice(0, 12)}`);
