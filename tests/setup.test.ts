import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import { keyOutcomeFromReason, pickClosingLine } from "../src/setup.js";

const BINARY = resolve(__dirname, "..", "build", "index.js");

describe("pickClosingLine", () => {
    it("returns one of the curated lines", () => {
        const known = new Set([
            "happy voice AI building",
            "let your agents do the talking",
            "time to ship some voice AI",
            "you're set. time to build.",
            "setup done. ready to ship your first voice AI agent?",
        ]);
        for (let i = 0; i < 30; i++) {
            expect(known.has(pickClosingLine())).toBe(true);
        }
    });
});

describe("keyOutcomeFromReason", () => {
    it("maps each failure reason to a distinct outcome", () => {
        expect(keyOutcomeFromReason("rejected_401")).toBe("rejected_401");
        expect(keyOutcomeFromReason("network_error")).toBe("network_error");
        expect(keyOutcomeFromReason("unexpected")).toBe("server_error");
    });

    it("treats no submitted key as an abort", () => {
        expect(keyOutcomeFromReason(null)).toBe("aborted");
    });
});

describe("binary entrypoint", () => {
    it("dispatches to setup when called with `setup` arg", () => {
        // Run with closed stdin so the prompt loop fails immediately rather
        // than hanging. Output must show the setup banner, not the install
        // help screen. Catches the 0.2.0-style regression.
        const result = spawnSync("node", [BINARY, "setup"], {
            input: "",
            timeout: 8000,
            encoding: "utf-8",
        });
        const out = (result.stdout ?? "") + (result.stderr ?? "");
        expect(out).toContain("OmniDimension");
        expect(out).toContain("MCP server setup");
        expect(out).not.toContain("Claude Desktop · Cursor · Windsurf");
    });
});
