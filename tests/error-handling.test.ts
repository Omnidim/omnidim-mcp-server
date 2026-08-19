import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

// Regression guard: every error return in executeApiTool must set isError:true
// so MCP clients can tell a failed call from a success. The success return must
// NOT set it. These are applied as regen.mjs patches; this test fails if a
// regen drops them.
const src = readFileSync(resolve(__dirname, "../src/index.ts"), "utf8");

describe("executeApiTool error signalling", () => {
    it("marks the validation error return", () => {
        expect(src).toContain(
            "{ isError: true, content: [{ type: 'text', text: validationErrorMessage }] }",
        );
    });

    it("marks the internal validation-setup error return", () => {
        expect(src).toContain(
            "isError: true, content: [{ type: 'text', text: `Internal error during validation setup:",
        );
    });

    it("marks the missing-api-key return", () => {
        expect(src).toMatch(
            /recordToolResult\(toolName, 'no_api_key'\);\s*return \{\s*isError: true,/,
        );
    });

    it("marks the catch-all execution error return", () => {
        expect(src).toContain(
            '{ isError: true, content: [{ type: "text", text: errorMessage }] }',
        );
    });

    it("does NOT mark the success return as an error", () => {
        const successReturn = src.match(
            /recordToolResult\(toolName, 'ok'\);\s*return \{[\s\S]*?API Response \(Status:/,
        );
        expect(successReturn).not.toBeNull();
        expect(successReturn![0]).not.toContain("isError");
    });
});
