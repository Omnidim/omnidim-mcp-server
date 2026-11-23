import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { flatInputSchema, nestBodyArgs } from "../src/flat-args.js";
import { buildToolSchema } from "../src/tool-schema.js";

const src = readFileSync(resolve(__dirname, "../src/index.ts"), "utf8");

function tool(name: string) {
    const start = src.indexOf(`  ["${name}", {`);
    if (start < 0) throw new Error(`no tool ${name}`);
    const block = src.slice(start, src.indexOf("\n  }],", start));
    const json = (key: string) => JSON.parse(block.split(`\n    ${key}: `)[1].split("\n")[0].replace(/,$/, ""));
    return { inputSchema: json("inputSchema"), executionParameters: json("executionParameters") };
}

const toolNames = [...src.matchAll(/^ {2}\["([A-Za-z]+)", \{/gm)].map((m) => m[1]);

function acceptsFlat(name: string, args: Record<string, unknown>) {
    const def = tool(name);
    return buildToolSchema(def.inputSchema).safeParse(nestBodyArgs(def, args)).success;
}

describe("flat tool arguments", () => {
    it("lists every tool with its body fields at the top level, except a body that may be a list", () => {
        const nested = toolNames.filter((n) => "requestBody" in (flatInputSchema(tool(n)).properties ?? {}));
        expect(nested).toEqual(["addWhatsappCampaignContacts"]);
    });

    it("keeps the body's required fields required", () => {
        expect(flatInputSchema(tool("createAgent")).required).toEqual(expect.arrayContaining(["name", "context_breakdown"]));
        expect(flatInputSchema(tool("dispatchCall")).required).toEqual(expect.arrayContaining(["agent_id", "to_number"]));
    });

    it("sends flat arguments in the shape each tool's validator expects", () => {
        expect(acceptsFlat("dispatchCall", { agent_id: 7, to_number: "+15551234567" })).toBe(true);
        expect(acceptsFlat("updateAgent", { agent_id: 7, welcome_message: "Hi" })).toBe(true);
        expect(acceptsFlat("attachPhoneNumber", { phone_number_id: 3, agent_id: 7 })).toBe(true);
        expect(acceptsFlat("addPostCallAction", { agent_id: 7, "Idempotency-Key": "k1", type: "omni_crm" })).toBe(true);
        expect(acceptsFlat("createAgent", { name: "A", context_breakdown: [{ title: "t", body: "b" }] })).toBe(true);
    });

    it("puts body fields in the body and path fields outside it", () => {
        expect(nestBodyArgs(tool("updateAgent"), { agent_id: 7, welcome_message: "Hi" }))
            .toEqual({ agent_id: 7, requestBody: { welcome_message: "Hi" } });
        expect(nestBodyArgs(tool("dispatchCall"), { agent_id: 7, to_number: "+1" }))
            .toEqual({ requestBody: { agent_id: 7, to_number: "+1" } });
    });

    it("passes a call that already sends requestBody through unchanged", () => {
        const args = { agent_id: 7, requestBody: { welcome_message: "Hi" } };
        expect(nestBodyArgs(tool("updateAgent"), args)).toBe(args);
    });
});
