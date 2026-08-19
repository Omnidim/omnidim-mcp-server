import { describe, expect, it } from "vitest";

import {
    PROMPT_NAMES,
    RESOURCE_URIS,
    getPromptText,
    getResourceText,
} from "../src/procedures.js";

describe("procedure layer registry", () => {
    it("exposes the provision_agent and audit_calls prompts and the routing resource", () => {
        expect(PROMPT_NAMES).toContain("provision_agent");
        expect(PROMPT_NAMES).toContain("audit_calls");
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

describe("audit_calls prompt", () => {
    it("weaves the focus in and applies filters", () => {
        const t = getPromptText("audit_calls", { focus: "why are calls failing", agent_id: "123", call_status: "failed" }) ?? "";
        expect(t).toContain("why are calls failing");
        expect(t).toContain("listCallLogs");
        expect(t).toContain('"agentid": 123');
        expect(t).toContain('"call_status": "failed"');
        expect(t).toContain("getCallLog");
    });

    it("keeps a small page size to avoid truncation", () => {
        const t = getPromptText("audit_calls", { focus: "summarize today" }) ?? "";
        expect(t).toContain('"pagesize": 3');
    });
});

describe("reference resources", () => {
    it("lists the recommended-stack, voices, and agent-config resources", () => {
        expect(RESOURCE_URIS).toContain("omnidim://reference/recommended-stack");
        expect(RESOURCE_URIS).toContain("omnidim://reference/voices");
        expect(RESOURCE_URIS).toContain("omnidim://reference/agent-config");
    });

    it("recommends providers by language using the createAgent enum values", () => {
        const t = getResourceText("omnidim://reference/recommended-stack") ?? "";
        expect(t).toContain("azure_stream");
        expect(t).toContain("soniox");
        expect(t).toContain("sarvam");
        expect(t).toContain("cartesia");
        expect(t).toContain("gpt-4.1-mini");
    });

    it("gives a copy-ready createAgent example with the requestBody wrapper", () => {
        const t = getResourceText("omnidim://reference/agent-config") ?? "";
        expect(t).toContain("requestBody");
        expect(t).toContain('"transcriber": { "provider": "azure_stream" }');
    });

    it("never exposes internal infra in any customer-facing resource", () => {
        for (const uri of RESOURCE_URIS) {
            const t = (getResourceText(uri) ?? "").toLowerCase();
            expect(t, `${uri} must not mention failover`).not.toContain("failover");
            expect(t, `${uri} must not mention the welcome model`).not.toContain("gpt-5.4");
        }
    });
});
