import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { toolAnnotations } from "../src/tool-annotations.js";

describe("toolAnnotations", () => {
    it("marks GET tools read-only and not open-world", () => {
        const a = toolAnnotations({ name: "listAgents", method: "get" });
        expect(a.readOnlyHint).toBe(true);
        expect(a.openWorldHint).toBe(false);
        expect(a.destructiveHint).toBeUndefined();
        expect(a.title).toBe("List agents");
    });

    it("treats preview/validate POSTs (canUploadFile) as read-only", () => {
        expect(toolAnnotations({ name: "canUploadFile", method: "post" }).readOnlyHint).toBe(true);
    });

    it("marks plain writes as non-destructive and not open-world", () => {
        const a = toolAnnotations({ name: "createAgent", method: "post" });
        expect(a.readOnlyHint).toBe(false);
        expect(a.destructiveHint).toBe(false);
        expect(a.openWorldHint).toBe(false);
    });

    it("marks deletes and removals destructive but not open-world", () => {
        for (const name of ["deleteAgent", "cancelBulkCall", "detachPhoneNumber"]) {
            const a = toolAnnotations({ name, method: "post" });
            expect(a.destructiveHint, name).toBe(true);
            expect(a.openWorldHint, name).toBe(false);
        }
    });

    it("marks call-placing tools destructive AND open-world", () => {
        for (const name of ["dispatchCall", "createBulkCall", "addBulkCallContact"]) {
            const a = toolAnnotations({ name, method: "post" });
            expect(a.readOnlyHint, name).toBe(false);
            expect(a.destructiveHint, name).toBe(true);
            expect(a.openWorldHint, name).toBe(true);
        }
    });

    it("marks phone number purchase and release destructive AND open-world", () => {
        for (const name of ["purchasePhoneNumber", "releasePhoneNumber"]) {
            const a = toolAnnotations({ name, method: "post" });
            expect(a.readOnlyHint, name).toBe(false);
            expect(a.destructiveHint, name).toBe(true);
            expect(a.openWorldHint, name).toBe(true);
        }
    });

    it("marks phone number search read-only", () => {
        const a = toolAnnotations({ name: "searchPhoneNumbers", method: "get" });
        expect(a.readOnlyHint).toBe(true);
        expect(a.openWorldHint).toBe(false);
        expect(a.title).toBe("Search available phone numbers");
    });

    it("gives every tool a human title", () => {
        expect(toolAnnotations({ name: "dispatchCall", method: "post" }).title).toBe("Dispatch call");
        expect(toolAnnotations({ name: "listLLMProviders", method: "get" }).title).toBe("List LLM providers");
    });

    it("marks restoring or deleting a saved version destructive", () => {
        for (const name of ["deleteAgentVersion", "restoreAgentVersion"]) {
            const a = toolAnnotations({ name, method: "post" });
            expect(a.destructiveHint, name).toBe(true);
            expect(a.openWorldHint, name).toBe(false);
        }
    });

    // Regen adds tools; titles are hand-authored. Without this guard a new
    // tool ships with no display name (the version-history tools did).
    it("titles every tool in the generated catalogue", () => {
        const src = readFileSync(resolve(__dirname, "../src/index.ts"), "utf8");
        const names = [...src.matchAll(/^\s{2}\["(\w+)", \{$/gm)].map((m) => m[1]);
        expect(names.length).toBeGreaterThan(40);
        const untitled = names.filter((name) => !toolAnnotations({ name, method: "get" }).title);
        expect(untitled).toEqual([]);
    });
});
