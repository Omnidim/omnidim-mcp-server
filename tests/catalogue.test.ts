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
    // Reseller operations: admin-level, several move money, KYC ones relay
    // identity documents. See mcp-config.yaml.
    "listChildOrganizations",
    "addUser",
    "setUserAccessControl",
    "setUserExpiry",
    "setChildConcurrency",
    "calculateCreditOperation",
    "transferCreditsToChild",
    "revertCreditsFromChild",
    "getResellerCreditLogs",
    "getResellerKycStatus",
    "getResellerKycRequirements",
    "submitResellerKycStep",
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

    it("exposes the bulk-call parity tools", () => {
        for (const name of [
            "startBulkCall", "addBulkCallContacts", "retryBulkCall",
            "setBulkCallConcurrency", "setBulkCallDailyTimeControl",
            "listBulkCallLines", "listBulkCallNumbers",
            "addBulkCallNumber", "setBulkCallNumberActive",
        ]) {
            expect(src).toContain(`["${name}"`);
        }
    });

    it("documents createBulkCall's draft, filtering, and rotation fields", () => {
        for (const field of ['"bot_id"', '"save_as_draft"', '"call_conditions"', '"rotation"']) {
            expect(src).toContain(field);
        }
    });

    it("exposes the phone number search, purchase, and release tools", () => {
        for (const name of ["searchPhoneNumbers", "purchasePhoneNumber", "releasePhoneNumber"]) {
            expect(src).toContain(`["${name}"`);
        }
    });

    it("documents createAgent's structured fields", () => {
        expect(src).toContain('"context_breakdown":{"type":"array"');
        expect(src).toContain('"required":["title","body"]');
        expect(src).toContain('"timezone":{"type":"string","description":"IANA timezone');
    });

    // Three places carry the version: package.json, the registry manifest,
    // and SERVER_VERSION (what initialize, the banner, and telemetry report).
    // Each has drifted before when a release bumped only package.json.
    it("keeps every declared version in step with the package version", () => {
        const pkg = JSON.parse(readFileSync(resolve(__dirname, "../package.json"), "utf8"));
        const manifest = JSON.parse(readFileSync(resolve(__dirname, "../server.json"), "utf8"));
        expect(manifest.version).toBe(pkg.version);
        for (const entry of manifest.packages) {
            expect(entry.version, entry.identifier).toBe(pkg.version);
        }
        expect(src).toContain(`export const SERVER_VERSION = "${pkg.version}";`);
    });

    it("keeps the instructions in sync with the exposed surface", () => {
        expect(src).toContain("Dispatching calls: run listPhoneNumbers first.");
        expect(src).not.toContain("Simulations: run scripted test scenarios");
    });
});
