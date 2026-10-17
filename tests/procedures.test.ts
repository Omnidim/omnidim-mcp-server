import { readFileSync } from "node:fs";
import { resolve } from "node:path";

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

describe("build_outbound_campaign prompt", () => {
    it("weaves the goal in and walks the draft-first lifecycle", () => {
        const t = getPromptText("build_outbound_campaign", { goal: "call 8,000 renewal leads today" }) ?? "";
        expect(t).toContain("call 8,000 renewal leads today");
        expect(t).toContain("createBulkCall");
        expect(t).toContain("save_as_draft: true");
        expect(t).toContain("addBulkCallContacts");
        expect(t).toContain("startBulkCall");
        expect(t).toContain("requestBody");
    });

    it("requires explicit user approval before starting", () => {
        const t = getPromptText("build_outbound_campaign", { goal: "x" }) ?? "";
        expect(t).toContain("never start one they have not approved");
        expect(t.indexOf("go-ahead")).toBeLessThan(t.indexOf("Then \`startBulkCall\`"));
    });

    it("pins the number and agent when given", () => {
        const t = getPromptText("build_outbound_campaign", { goal: "x", agent_id: "42", phone_number_id: "177" }) ?? "";
        expect(t).toContain('phone_number_id "177"');
        expect(t).toContain("bot_id 42");
    });

    it("teaches the concurrency arithmetic and the timezone trap", () => {
        const t = getPromptText("build_outbound_campaign", { goal: "x" }) ?? "";
        expect(t).toContain("3600 / average call seconds");
        expect(t).toContain("daily_stop_timezone");
        expect(t).toContain("agent's own `timezone` field");
    });
});

describe("bulk campaigns resource", () => {
    const text = getResourceText("omnidim://guide/bulk-campaigns") ?? "";
    it("is listed and documents the load-bearing rules", () => {
        expect(RESOURCE_URIS).toContain("omnidim://guide/bulk-campaigns");
        expect(text).toContain("to_number");
        expect(text).toContain("contact_list");
        expect(text).toContain("next_cursor");
        expect(text).toContain("save_as_draft");
        expect(text).toContain("3600 / average call seconds");
        expect(text).toContain("daily_stop_timezone");
        expect(text).toContain("agent has its own `timezone` field");
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

describe("build_workflow prompt and workflows guide", () => {
    it("asks before a real test run", () => {
        const t = getPromptText("build_workflow", { goal: "Follow up interested leads on WhatsApp" }) ?? "";
        expect(t).toContain("Follow up interested leads on WhatsApp");
        expect(t).toContain("omnidim://guide/workflows");
        expect(t).toContain("for real"); // test runs send real messages; the model must ask first
    });

    it("covers building end to end", () => {
        const guide = getResourceText("omnidim://guide/workflows") ?? "";
        for (const topic of ["## Lifecycle", "## Entry", "## Connecting", "## Exit", "## Moving", "## Notes"]) {
            expect(guide, topic).toContain(topic);
        }
    });

    it("keeps the safety sections and the consent clause", () => {
        const guide = getResourceText("omnidim://guide/workflows") ?? "";
        expect(guide).toContain("## Test runs are real");
        expect(guide).toContain("## Credentials");
        const prompt = getPromptText("build_workflow", { goal: "x" }) ?? "";
        expect(prompt).toContain("Only call `testWorkflow` after the\n   user says yes");
    });

    it("warns against breaking a running workflow", () => {
        const guide = getResourceText("omnidim://guide/workflows") ?? "";
        expect(guide).toContain("## Do not break a workflow that is already running");
        expect(guide).toContain("overwrites");
    });

    // The guide and prompt steer the model by tool name. A renamed operation
    // must fail here, not leave the model calling a tool the server does not have.
    it("names only tools that exist", () => {
        const guide = getResourceText("omnidim://guide/workflows") ?? "";
        const prompt = getPromptText("build_workflow", { goal: "x" }) ?? "";
        const src = readFileSync(resolve(__dirname, "../src/index.ts"), "utf8");
        const tools = new Set([...src.matchAll(/^\s{2}\["(\w+)", \{$/gm)].map((m) => m[1]));
        const named = new Set([...(guide + prompt).matchAll(/`([a-z]+Workflow[A-Za-z]*)`/g)].map((m) => m[1]));
        expect(named.size).toBeGreaterThan(0);
        expect([...named].filter((n) => !tools.has(n))).toEqual([]);
    });
});

describe("reseller client selection", () => {
    // user_id lets a reseller key act for another client. It must never be
    // reachable from an LLM-driven tool, as a query param or a body property.
    it("exposes no user_id on any tool", () => {
        const src = readFileSync(resolve(__dirname, "../src/index.ts"), "utf8");
        expect(src).not.toContain("user_id");
    });
});
