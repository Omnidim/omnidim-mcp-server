import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { foldMergedTools, isMergedTool, pickMergedAction, unknownToolMessage } from "../src/merged-tools.js";

const def = (name: string, path: string, body?: Record<string, any>) => ({
    name,
    description: `${name} does it.\n(Tags: Phone numbers)`,
    inputSchema: {
        type: "object",
        properties: {
            id: { type: "integer" },
            ...(body ? { requestBody: { type: "object", ...body } } : {}),
        },
        required: ["id", ...(body ? ["requestBody"] : [])],
    },
    method: "post",
    pathTemplate: path,
    executionParameters: [{ name: "id", in: "path" }],
    securityRequirements: [],
});

const groups = {
    phoneNumberAgentActions: { description: "Attach or detach a number.", field: "action" },
    bulkCallActions: { description: "Control a campaign.", field: "action" },
};
const members = {
    attachPhoneNumber: { tool: "phoneNumberAgentActions", actions: ["attach"], passes: false },
    detachPhoneNumber: { tool: "phoneNumberAgentActions", actions: ["detach"], passes: false },
    startBulkCall: { tool: "bulkCallActions", actions: ["start"], passes: false },
    bulkCallActions: { tool: "bulkCallActions", actions: ["pause", "resume"], passes: true },
};

function folded() {
    const map = new Map<string, any>([
        ["attachPhoneNumber", def("attachPhoneNumber", "/numbers/{id}/attach", {
            properties: { agent_id: { type: "integer", description: "The agent." } },
            required: ["agent_id"],
        })],
        ["detachPhoneNumber", def("detachPhoneNumber", "/numbers/{id}/detach")],
        ["startBulkCall", def("startBulkCall", "/bulk/{id}/start")],
        ["bulkCallActions", def("bulkCallActions", "/bulk/{id}/actions", {
            properties: { action: { type: "string", enum: ["pause", "resume"] } },
            required: ["action"],
        })],
        ["listAgents", def("listAgents", "/agents")],
    ]);
    foldMergedTools(map, groups, members);
    return map;
}

describe("merged tools", () => {
    it("folds each group into one tool and drops its operations", () => {
        expect([...folded().keys()].sort()).toEqual(["bulkCallActions", "listAgents", "phoneNumberAgentActions"]);
    });

    it("gives the merged tool an action field and the inputs every action needs", () => {
        const tool = folded().get("phoneNumberAgentActions");
        expect(isMergedTool(tool)).toBe(true);
        expect(tool.inputSchema.properties.action.enum).toEqual(["attach", "detach"]);
        expect(tool.inputSchema.required).toEqual(["action", "id"]);
        expect(tool.inputSchema.properties.agent_id.description).toBe("Only for `attach`. The agent.");
        expect(tool.description).toContain("`detach`: detachPhoneNumber does it.");
        expect(tool.description).not.toContain("(Tags:");
    });

    it("routes an action to its operation with only that operation's inputs", () => {
        const picked = pickMergedAction(folded().get("phoneNumberAgentActions"), { action: "detach", id: 9, agent_id: 3 });
        expect("def" in picked && picked.def.pathTemplate).toBe("/numbers/{id}/detach");
        expect("args" in picked && picked.args).toEqual({ id: 9 });
    });

    it("passes a listed action through to the operation body", () => {
        const picked = pickMergedAction(folded().get("bulkCallActions"), { action: "pause", id: 4 });
        expect("def" in picked && picked.def.pathTemplate).toBe("/bulk/{id}/actions");
        expect("args" in picked && picked.args).toEqual({ action: "pause", id: 4 });
    });

    it("asks for an input the action needs", () => {
        expect(pickMergedAction(folded().get("phoneNumberAgentActions"), { action: "attach", id: 9 })).toEqual({
            error: "action attach needs: agent_id",
        });
    });

    it.each([[{ id: 4 }], [{ action: "explode", id: 4 }]])("lists the choices for an unknown action %j", (args) => {
        expect(pickMergedAction(folded().get("bulkCallActions"), args)).toEqual({
            error: "action must be one of: start, pause, resume",
        });
    });

    it("fails a group whose inputs disagree", () => {
        const map = new Map<string, any>([
            ["attachPhoneNumber", def("attachPhoneNumber", "/a/{id}")],
            ["detachPhoneNumber", { ...def("detachPhoneNumber", "/d/{id}"), inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] } }],
        ]);
        expect(() => foldMergedTools(map, groups, members)).toThrow("phoneNumberAgentActions: input id differs");
    });

    it("points an old tool name at its new tool", () => {
        expect(unknownToolMessage("detachPhoneNumber", members, groups)).toBe(
            "Unknown tool requested: detachPhoneNumber. Call phoneNumberAgentActions with action detach.",
        );
        expect(unknownToolMessage("launchRocket", members, groups)).toBe("Unknown tool requested: launchRocket");
        expect(unknownToolMessage("bulkCallActions", members, groups)).toBe("Unknown tool requested: bulkCallActions");
    });

    it("is applied to the served tool map before the read-only filter and the call handler", () => {
        const src = readFileSync(resolve(__dirname, "..", "src", "index.ts"), "utf8");
        const fold = src.indexOf("foldMergedTools(toolDefinitionMap);");
        expect(fold).toBeGreaterThan(src.indexOf("addGuideTool(toolDefinitionMap);"));
        expect(fold).toBeLessThan(src.indexOf("if (readOnlyMode()) keepReadOnlyTools(toolDefinitionMap);"));
        expect(src).toContain("if (isMergedTool(toolDefinition))");
        expect(src).toContain("unknownToolMessage(toolName)");
    });
});

describe("merged tool inputs", () => {
    it("drops another action's input whatever its case", () => {
        const map = new Map<string, any>([
            ["startBulkCall", { ...def("startBulkCall", "/bulk/{id}/start"), executionParameters: [{ name: "id", in: "path" }, { name: "Idempotency-Key", in: "header" }],
                inputSchema: { type: "object", properties: { id: { type: "integer" }, "Idempotency-Key": { type: "string" } }, required: ["id", "Idempotency-Key"] } }],
            ["bulkCallActions", def("bulkCallActions", "/bulk/{id}/actions", { properties: { action: { type: "string", enum: ["pause", "resume"] } }, required: ["action"] })],
        ]);
        foldMergedTools(map, groups, members);
        const picked = pickMergedAction(map.get("bulkCallActions"), { action: "pause", id: 4, "IDEMPOTENCY-KEY": "k" });
        expect("args" in picked && picked.args).toEqual({ action: "pause", id: 4 });
    });

    it("treats inputs that differ only in key order as the same", () => {
        const map = new Map<string, any>([
            ["attachPhoneNumber", { ...def("attachPhoneNumber", "/a/{id}"), inputSchema: { type: "object", properties: { id: { type: "integer", minimum: 1 } }, required: ["id"] } }],
            ["detachPhoneNumber", { ...def("detachPhoneNumber", "/d/{id}"), inputSchema: { type: "object", properties: { id: { minimum: 1, type: "integer" } }, required: ["id"] } }],
        ]);
        expect(() => foldMergedTools(map, groups, members)).not.toThrow();
    });
});
