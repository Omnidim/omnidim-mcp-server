// Regen builds tools from each operation's x-mcp block in the spec: title, confirm
// hints, hidden, and inputs to drop. An operation without one fails the regen.
import { describe, expect, it } from "vitest";

// @ts-expect-error plain ESM helper shared by scripts/regen.mjs and scripts/check-spec.mjs
import { annotationsFor, applyBriefs, mcpMarks } from "../scripts/x-mcp.mjs";

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
    [{ title: 5, effect: "write" }],
    [{ hidden: null }],
    [{ hidden: false }],
    [{ title: "T", effect: "write", "hide-params": "user_id" }],
    [{ title: "T", effect: "write", "hide-params": [1] }],
    [{ title: "T", effect: "write", "open-world": 1 }],
    [{ title: "T", effect: ["write"] }],
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

describe("x-mcp-brief", () => {
    const BRIEF = "Post-call actions. Add them with addPostCallAction.";
    const spec = (brief: unknown) => ({
        components: {
            schemas: {
                Big: {
                    type: "object",
                    "x-mcp-brief": brief,
                    properties: Object.fromEntries(Array.from({ length: 40 }, (_, i) => [`f${i}`, { type: "string" }])),
                },
                Small: { type: "object", properties: { a: { type: "string" } } },
            },
        },
    });

    it("swaps a briefed schema for one free-form line and leaves others alone", () => {
        const s = spec(BRIEF);
        expect(applyBriefs(s)).toBe(1);
        expect(s.components.schemas.Big).toEqual({ type: "object", additionalProperties: true, description: BRIEF });
        expect(s.components.schemas.Small).toEqual({ type: "object", properties: { a: { type: "string" } } });
    });

    it.each(["", "  ", 3, "two\nlines", "x".repeat(401)])("fails a bad brief %j", (brief) => {
        expect(() => applyBriefs(spec(brief))).toThrow("bad x-mcp-brief on Big");
    });
});
