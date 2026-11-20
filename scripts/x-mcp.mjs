// Reads the x-mcp block each spec operation carries. It is the one source for a
// tool's title, its confirm hints, whether it is hidden, and inputs to drop.
// The hosted server (omnidim-mcp-cloud scripts/regen.py) applies the same rules.

const KEYS = new Set(['title', 'effect', 'open-world', 'hide-params', 'hidden']);
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
  return marks;
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
