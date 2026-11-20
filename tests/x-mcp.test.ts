// Regen builds tools from each operation's x-mcp block in the spec: title, confirm
// hints, hidden, and inputs to drop. An operation without one fails the regen.
import { describe, expect, it } from "vitest";

// @ts-expect-error plain ESM helper shared by scripts/regen.mjs and scripts/check-spec.mjs
import { annotationsFor, mcpMarks } from "../scripts/x-mcp.mjs";

describe("x-mcp marks", () => {
  it("fails an operation with no block", () => {
    expect(() => mcpMarks("newThing", "post", {})).toThrow("newThing has no x-mcp block");
  });

  it.each([
    [{ title: "T", effect: "maybe" }],
    [{ effect: "read" }],
    [{ title: "T", effect: "read", "open-world": true }],
    [{ title: "T", effect: "write", colour: "red" }],
    [{ hidden: "" }],
    [{ hidden: "why", title: "T" }],
  ])("fails a malformed block %j", (block) => {
    expect(() => mcpMarks("op", "post", { "x-mcp": block })).toThrow("bad x-mcp on op");
  });

  it("fails a GET that is not a read", () => {
    expect(() => mcpMarks("op", "get", { "x-mcp": { title: "T", effect: "write" } })).toThrow(
      "bad x-mcp on op",
    );
  });

  it("passes a hidden block through", () => {
    expect(mcpMarks("op", "post", { "x-mcp": { hidden: "Admin only." } })).toEqual({
      hidden: "Admin only.",
    });
  });

  it.each([
    [
      { title: "List things", effect: "read" },
      { title: "List things", readOnlyHint: true, openWorldHint: false },
    ],
    [
      { title: "Save thing", effect: "write" },
      { title: "Save thing", readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    ],
    [
      { title: "Call someone", effect: "destructive", "open-world": true },
      { title: "Call someone", readOnlyHint: false, destructiveHint: true, openWorldHint: true },
    ],
  ])("maps %j to hints", (block, expected) => {
    expect(annotationsFor(block)).toEqual(expected);
  });
});
