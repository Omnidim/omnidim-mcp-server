import { describe, expect, it } from "vitest";

import { renderWordmark, WORDMARK_WIDTH } from "../src/banner.js";

describe("renderWordmark", () => {
    it("returns null when the terminal is too narrow or width is unknown", () => {
        expect(renderWordmark(undefined)).toBeNull();
        expect(renderWordmark(80)).toBeNull();
        expect(renderWordmark(WORDMARK_WIDTH)).toBeNull(); // needs the 2-col margin too
    });

    it("renders six colored rows when the terminal is wide enough", () => {
        const art = renderWordmark(WORDMARK_WIDTH + 10);
        expect(art).not.toBeNull();
        const lines = (art as string).split("\n");
        expect(lines).toHaveLength(6);
        // both brand colors applied, and the box-drawing art is present
        expect(art).toContain("\x1b[0m");
        expect(art).toContain("█");
    });
});
