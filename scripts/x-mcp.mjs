// Reads the x-mcp block each spec operation carries. It is the one source for a
// tool's title, its confirm hints, whether it is hidden, and inputs to drop.
// The hosted server (omnidim-mcp-cloud scripts/regen.py) applies the same rules.

const KEYS = new Set(['title', 'effect', 'open-world', 'hide-params', 'hidden', 'merge']);
const ACTION = /^[a-z][a-z_]*$/;
const EFFECT_RANK = { read: 0, write: 1, destructive: 2 };
const GROUP_KEYS = new Set(['title', 'description', 'field']);

export function mergeActions(merge) {
  return Array.isArray(merge.action) ? merge.action : [merge.action];
}

function validMerge(merge) {
  if (!merge || typeof merge !== 'object' || Array.isArray(merge)) return false;
  if (Object.keys(merge).sort().join() !== 'action,tool') return false;
  if (typeof merge.tool !== 'string' || !merge.tool) return false;
  const actions = mergeActions(merge);
  return actions.length > 0 && actions.every((a) => typeof a === 'string' && ACTION.test(a));
}
const EFFECTS = ['read', 'write', 'destructive'];

/** The operation's x-mcp block, checked. Throws on a missing or bad one. */
export function mcpMarks(opId, method, op) {
  const marks = op?.['x-mcp'];
  if (marks === undefined) throw new Error(`${opId} has no x-mcp block: add one to the spec`);
  const bad = (why) => new Error(`bad x-mcp on ${opId}: ${why}`);
  if (!marks || typeof marks !== 'object' || Array.isArray(marks)) throw bad('not a mapping');
  const unknown = Object.keys(marks).filter((k) => !KEYS.has(k));
  if (unknown.length) throw bad(`unknown keys ${unknown.join(', ')}`);
  if ('hidden' in marks) {
    const reason = marks.hidden;
    if (Object.keys(marks).length !== 1 || typeof reason !== 'string' || !reason.trim()) {
      throw bad('hidden takes a reason, as text, and no other keys');
    }
    return marks;
  }
  if (typeof marks.title !== 'string' || !marks.title.trim()) throw bad('title is required, as text');
  if (!EFFECTS.includes(marks.effect)) throw bad(`effect must be one of ${EFFECTS.join(', ')}`);
  if (method === 'get' && marks.effect !== 'read') throw bad('a GET is a read');
  if (!(marks['open-world'] === undefined || marks['open-world'] === true) ||
      (marks['open-world'] && marks.effect === 'read')) {
    throw bad('open-world is true on a write, or absent');
  }
  const hide = marks['hide-params'] ?? [];
  if (!Array.isArray(hide) || !hide.every((n) => typeof n === 'string')) {
    throw bad('hide-params is a list of input names');
  }
  if ('merge' in marks && !validMerge(marks.merge)) {
    throw bad('merge takes tool, as text, and action, a snake_case word or a list of them');
  }
  return marks;
}

function mergeGroup(name, groups) {
  const group = groups?.[name];
  if (!group || typeof group !== 'object') throw new Error(`${name} is not declared under x-mcp-tools`);
  const unknown = Object.keys(group).filter((k) => !GROUP_KEYS.has(k));
  if (unknown.length) throw new Error(`bad x-mcp-tools entry ${name}: unknown keys ${unknown.join(', ')}`);
  for (const key of ['title', 'description']) {
    if (typeof group[key] !== 'string' || !group[key].trim()) {
      throw new Error(`bad x-mcp-tools entry ${name}: ${key} is required, as text`);
    }
  }
  if (typeof (group.field ?? 'action') !== 'string') throw new Error(`bad x-mcp-tools entry ${name}: field is text`);
  return group;
}

export function mergePlan(groups, merged) {
  const byTool = {};
  for (const m of merged) (byTool[m.marks.merge.tool] ??= []).push(m);
  const plan = { groups: {}, members: {}, marks: {} };
  for (const [name, members] of Object.entries(byTool)) {
    const group = mergeGroup(name, groups);
    if (members.length < 2) throw new Error(`${name} folds one operation: merge two or more, or drop the mark`);
    const seen = new Set();
    for (const { opId, marks } of members) {
      const actions = mergeActions(marks.merge);
      for (const a of actions) {
        if (seen.has(a)) throw new Error(`${name}: action ${a} names two operations`);
        seen.add(a);
      }
      plan.members[opId] = { tool: name, actions, passes: Array.isArray(marks.merge.action) };
    }
    const effect = members
      .map((m) => m.marks.effect)
      .reduce((a, b) => (EFFECT_RANK[b] > EFFECT_RANK[a] ? b : a));
    const openWorld = members.some((m) => m.marks['open-world']);
    plan.groups[name] = { description: group.description, field: group.field ?? 'action' };
    plan.marks[name] = annotationsFor({ title: group.title, effect, ...(openWorld ? { 'open-world': true } : {}) });
  }
  return plan;
}

/** MCP annotations, set explicitly because the spec defaults are conservative. */
export function annotationsFor(marks) {
  if (marks.effect === 'read') {
    return { title: marks.title, readOnlyHint: true, openWorldHint: false };
  }
  return {
    title: marks.title,
    readOnlyHint: false,
    destructiveHint: marks.effect === 'destructive',
    openWorldHint: Boolean(marks['open-world']),
  };
}

// A schema marked x-mcp-brief becomes a free-form object described by that one line, so a large
// shape repeated across tools (post-call actions) costs one line in each. Same rule as the hosted
// server's scripts/regen.py apply_briefs.
export function applyBriefs(spec) {
  let swapped = 0;
  const schemas = spec?.components?.schemas ?? {};
  for (const [name, schema] of Object.entries(schemas)) {
    if (!schema || typeof schema !== 'object' || !('x-mcp-brief' in schema)) continue;
    const brief = schema['x-mcp-brief'];
    if (typeof brief !== 'string' || !brief.trim() || brief.includes('\n') || brief.length > 400) {
      throw new Error(`bad x-mcp-brief on ${name}: one line of text, 400 chars at most`);
    }
    schemas[name] = { type: 'object', additionalProperties: true, description: brief };
    swapped += 1;
  }
  return swapped;
}
