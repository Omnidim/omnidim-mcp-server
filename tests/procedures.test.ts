import { describe, expect, it } from "vitest";

import {
    PROMPT_NAMES,
    RESOURCE_URIS,
    getPromptText,
    getResourceText,
} from "../src/procedures.js";

describe("procedure layer registry", () => {
    it("exposes the provision_agent prompt and the routing resource", () => {
        expect(PROMPT_NAMES).toContain("provision_agent");
        expect(RESOURCE_URIS).toContain("omnidim://guide/routing");
    });

    it("returns null for unknown prompt or resource", () => {
        expect(getPromptText("nope")).toBeNull();
        expect(getResourceText("omnidim://nope")).toBeNull();
    });
});

describe("routing guide resource", () => {
    const text = getResourceText("omnidim://guide/routing") ?? "";
    it("documents the proven gotchas", () => {
        expect(text).toContain("requestBody");
        expect(text).toContain("voice_id");
        expect(text).toMatch(/does NOT mean a call\s*\n?\s*connected/);
    });
});

describe("provision_agent prompt", () => {
    it("weaves the purpose into the procedure", () => {
        const t = getPromptText("provision_agent", { purpose: "book dental appointments" }) ?? "";
        expect(t).toContain("book dental appointments");
        expect(t).toContain("createAgent");
        expect(t).toContain("attachPhoneNumber");
        expect(t).toContain("deepgram_stream");
        expect(t).toContain("requestBody");
    });

    it("adds the verification call only when a test_number is given", () => {
        const withNum = getPromptText("provision_agent", { purpose: "x", test_number: "+15551234567" }) ?? "";
        expect(withNum).toContain("+15551234567");
        expect(withNum).toContain("call_conversation");
        const without = getPromptText("provision_agent", { purpose: "x" }) ?? "";
        expect(without).not.toContain("dispatchCall { requestBody: { agent_id, to_number:");
    });
});
