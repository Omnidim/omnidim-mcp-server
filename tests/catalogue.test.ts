import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

// Regression guard on the generated catalogue: regen must honor the shared
// exposure config and keep the embedded instructions in sync with it.
const src = readFileSync(resolve(__dirname, "../src/index.ts"), "utf8");

const EXCLUDED_TOOLS = [
    "listSimulations",
    "createSimulation",
    "getSimulation",
    "updateSimulation",
    "deleteSimulation",
    "startSimulation",
    "stopSimulation",
    "enhancePrompt",
];

describe("generated tool catalogue", () => {
    it("does not expose excluded tools", () => {
        for (const name of EXCLUDED_TOOLS) {
            expect(src, `tool ${name} should be excluded`).not.toContain(`["${name}"`);
        }
    });

    it("keeps the core agent and call tools", () => {
        for (const name of ["createAgent", "updateAgent", "dispatchCall", "listPhoneNumbers"]) {
            expect(src).toContain(`["${name}"`);
        }
    });

    it("documents createAgent's structured fields", () => {
        expect(src).toContain('"context_breakdown":{"type":"array"');
        expect(src).toContain('"required":["title","body"]');
    });

    it("keeps the instructions in sync with the exposed surface", () => {
        expect(src).toContain("Dispatching calls: run listPhoneNumbers first.");
        expect(src).not.toContain("Simulations: run scripted test scenarios");
    });
});
