import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

// Guards the regen patch that pins the backend to production. An
// env-overridable base URL is a credential-exfiltration surface (the
// server attaches the bearer key to every request to whatever the URL
// points at), so a regen must never silently restore the override.
const src = readFileSync(resolve(__dirname, "../src/index.ts"), "utf8");

describe("API base URL", () => {
    it("is pinned to the production backend", () => {
        expect(src).toContain(
            'export const API_BASE_URL = "https://backend.omnidim.io/api/v1";',
        );
    });

    it("is not overridable via environment variable", () => {
        expect(src).not.toContain("process.env.API_BASE_URL");
    });
});
