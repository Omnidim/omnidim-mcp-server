import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

// Guards the regen patch that puts the server's request id in API error text, so a user
// can quote it to support and we can find the exact request.
const src = readFileSync(resolve(__dirname, "../src/index.ts"), "utf8");

describe("API error text", () => {
    it("carries the server's request id", () => {
        const fn = src.slice(src.indexOf("function formatApiError"));
        expect(fn.slice(0, fn.indexOf("\n}\n"))).toContain("requestIdNote(error.response.headers)");
    });

    it("imports the helper that reads it", () => {
        expect(src).toMatch(/import \{[^}]*\brequestIdNote\b[^}]*\} from "\.\/helpers\.js";/);
    });
});
