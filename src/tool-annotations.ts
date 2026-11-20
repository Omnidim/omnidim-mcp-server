// MCP tool annotations: a display title plus read-only / destructive /
// open-world hints, so clients can parallelize reads and confirm before
// destructive or real-world actions. index.ts imports toolAnnotations and
// applies it in the tools/list handler.
import { TOOL_MARKS } from "./tool-marks.js";

export interface ToolAnnotations {
  title?: string;
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  openWorldHint?: boolean;
}

// Tools that are not spec operations, so they carry no x-mcp block.
const HAND_MARKS: Record<string, ToolAnnotations> = {
  showWorkflow: { title: "Show workflow canvas", readOnlyHint: true, openWorldHint: false },
  searchDocs: { title: "Search the docs", readOnlyHint: true, openWorldHint: false },
  readDoc: { title: "Read a docs page", readOnlyHint: true, openWorldHint: false },
};

// Spec tools get their marks from the spec's x-mcp block, through regen.
export function toolAnnotations(def: { name: string; method: string }): ToolAnnotations {
  return { ...(TOOL_MARKS[def.name] ?? HAND_MARKS[def.name] ?? {}) };
}

// OMNIDIM_READONLY=1 serves only tools that read data, so an agent cannot change the account or place a call.
export function readOnlyMode(env: Record<string, string | undefined> = process.env): boolean {
  return ["1", "true", "on", "yes"].includes((env.OMNIDIM_READONLY ?? "").toLowerCase());
}

export function keepReadOnlyTools(map: Map<string, { name: string; method: string }>): void {
  for (const def of [...map.values()]) {
    if (!toolAnnotations(def).readOnlyHint) map.delete(def.name);
  }
}
