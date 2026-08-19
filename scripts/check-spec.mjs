#!/usr/bin/env node
/**
 * Compare the committed tool catalogue against the published OpenAPI spec.
 *
 * A full `npm run regen` diff can't be the gate: the generator's output has
 * unrelated formatting drift (see the maintainer notes), so this checks the
 * two things that actually matter - the spec hash the catalogue was built
 * from, and the set of exposed tool names.
 *
 * Usage: node scripts/check-spec.mjs
 */
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SPEC_URL = 'https://docs.omnidim.io/openapi.yaml';
const METHODS = ['get', 'post', 'put', 'patch', 'delete'];

// SPEC points at a local file, same override regen.mjs takes.
let specBytes;
if (process.env.SPEC) {
  specBytes = readFileSync(resolve(process.env.SPEC));
} else {
  const res = await fetch(SPEC_URL);
  if (!res.ok) {
    console.error(`failed to fetch spec: ${res.status}`);
    process.exit(1);
  }
  specBytes = Buffer.from(await res.arrayBuffer());
}
const specHash = createHash('sha256').update(specBytes).digest('hex');
const spec = yaml.load(specBytes.toString('utf8'));

const sentinel = Object.fromEntries(
  readFileSync(resolve(ROOT, '.spec.yml'), 'utf8')
    .split('\n')
    .filter((l) => l.includes(': '))
    .map((l) => l.split(': ').map((s) => s.trim())),
);

const excludeCfg = yaml.load(readFileSync(resolve(ROOT, 'mcp-config.yaml'), 'utf8'))?.exclude ?? {};
const excludedPaths = new Set(excludeCfg.paths ?? []);
const excludedOps = new Set(excludeCfg.operation_ids ?? []);

const expected = new Set();
for (const [specPath, item] of Object.entries(spec.paths ?? {})) {
  if (excludedPaths.has(specPath)) continue;
  for (const m of METHODS) {
    const op = item[m];
    if (op && !excludedOps.has(op.operationId)) expected.add(op.operationId);
  }
}

const src = readFileSync(resolve(ROOT, 'src/index.ts'), 'utf8');
const exposed = new Set([...src.matchAll(/^\s{2}\["(\w+)", \{$/gm)].map((m) => m[1]));

const problems = [];
if (sentinel.openapi_spec_hash !== specHash) {
  problems.push(
    `spec moved: committed ${sentinel.openapi_spec_hash?.slice(0, 12)}, upstream ${specHash.slice(0, 12)}`,
  );
}
const added = [...expected].filter((n) => !exposed.has(n)).sort();
const gone = [...exposed].filter((n) => !expected.has(n)).sort();
if (added.length) problems.push(`upstream added tools not exposed: ${added.join(', ')}`);
if (gone.length) problems.push(`exposed tools no longer in the spec: ${gone.join(', ')}`);

if (problems.length) {
  for (const p of problems) console.error(`drift: ${p}`);
  console.error('run npm run regen and commit the result');
  process.exit(1);
}
console.log(`in sync. ${exposed.size} tools, spec ${specHash.slice(0, 12)}.`);
