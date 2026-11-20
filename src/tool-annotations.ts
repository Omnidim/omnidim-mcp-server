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
};

// Spec tools get their marks from the spec's x-mcp block, through regen.
export function toolAnnotations(def: { name: string; method: string }): ToolAnnotations {
  return { ...(TOOL_MARKS[def.name] ?? HAND_MARKS[def.name] ?? {}) };
}
