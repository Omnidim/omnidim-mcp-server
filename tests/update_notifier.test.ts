import { describe, expect, it } from "vitest";

import { availableNotice, isNewer, releaseTagUrl, updatedNotice } from "../src/update_notifier.js";

describe("isNewer", () => {
    it("compares semver across major/minor/patch", () => {
        expect(isNewer("0.6.0", "0.5.1")).toBe(true);
        expect(isNewer("1.0.0", "0.9.9")).toBe(true);
        expect(isNewer("0.6.1", "0.6.0")).toBe(true);
        expect(isNewer("0.6.0", "0.6.0")).toBe(false);
        expect(isNewer("0.5.1", "0.6.0")).toBe(false);
    });
    it("ignores a pre-release suffix", () => {
        expect(isNewer("0.6.0-beta.1", "0.6.0")).toBe(false);
    });
});

describe("notices", () => {
    it("link to the matching release tag", () => {
        expect(releaseTagUrl("0.6.0")).toBe("https://github.com/Omnidim/omnidim-mcp-server/releases/tag/v0.6.0");
        expect(updatedNotice("0.6.0")).toContain("v0.6.0");
        expect(updatedNotice("0.6.0")).toContain("releases/tag/v0.6.0");
    });
    it("available notice names both versions and says it auto-updates on restart", () => {
        const n = availableNotice("0.6.0", "0.7.0");
        expect(n).toContain("v0.7.0");
        expect(n).toContain("v0.6.0");
        expect(n).toContain("updates automatically");
    });
});
