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

    it("treats preview/validate POSTs (canUploadFile, calculateCreditOperation) as read-only", () => {
        expect(toolAnnotations({ name: "canUploadFile", method: "post" }).readOnlyHint).toBe(true);
        expect(toolAnnotations({ name: "calculateCreditOperation", method: "post" }).readOnlyHint).toBe(true);
    });

    it("marks plain writes as non-destructive and not open-world", () => {
        const a = toolAnnotations({ name: "createAgent", method: "post" });
        expect(a.readOnlyHint).toBe(false);
        expect(a.destructiveHint).toBe(false);
        expect(a.openWorldHint).toBe(false);
    });

    it("marks deletes and removals destructive but not open-world", () => {
        for (const name of ["deleteAgent", "cancelBulkCall", "detachPhoneNumber", "revertCreditsFromChild"]) {
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

    it("gives every tool a human title", () => {
        expect(toolAnnotations({ name: "dispatchCall", method: "post" }).title).toBe("Dispatch call");
        expect(toolAnnotations({ name: "listLLMProviders", method: "get" }).title).toBe("List LLM providers");
    });
});
