import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { getResourceText, listResources } from "../src/procedures.js";
import { WORKFLOW_CANVAS_URI, readWorkflow, toolMeta } from "../src/workflow-canvas.js";

const result = (text: string) => ({ content: [{ type: "text", text }] });
const draft = { version_id: 1, revision: "abc", nodes: [{ id: "trigger", type: "trigger" }], edges: [] };

describe("workflow canvas tool link", () => {
    it("links the workflow tools that return or change a draft", () => {
        for (const name of ["getWorkflow", "createWorkflow", "editWorkflow"]) {
            expect(toolMeta(name), name).toEqual({ ui: { resourceUri: WORKFLOW_CANVAS_URI } });
        }
    });

    it("leaves every other tool without a view", () => {
        expect(toolMeta("listWorkflows")).toBeUndefined();
        expect(toolMeta("dispatchCall")).toBeUndefined();
    });

    it("is applied in the generated tools/list handler", () => {
        const src = readFileSync(resolve(__dirname, "../src/index.ts"), "utf8");
        expect(src).toContain("_meta: toolMeta(def.name)");
    });
});

describe("workflow canvas resource", () => {
    it("is served as an MCP App view", () => {
        const r = listResources().find((x) => x.uri === WORKFLOW_CANVAS_URI);
        expect(r?.mimeType).toBe("text/html;profile=mcp-app");
        expect(WORKFLOW_CANVAS_URI.startsWith("ui://")).toBe(true);
    });

    it("ships a working, self-contained parser inside the page", () => {
        const html = getResourceText(WORKFLOW_CANVAS_URI) ?? "";
        expect(html).toContain("ui/initialize");
        const src = html.match(/const readWorkflow = ([\s\S]*?);\nconst NODE_W/)?.[1] ?? "";
        const embedded = new Function(`return (${src});`)();
        const body = JSON.stringify({ workflow: { id: 3, draft } });
        expect(embedded(result(`API Response (Status: 200):\n${body}`)).workflowId).toBe(3);
    });
});

describe("readWorkflow", () => {
    it("reads the workflow from a getWorkflow result", () => {
        const wf = { id: 7, name: "Router", status: "draft", draft };
        const got = readWorkflow(result(`API Response (Status: 200):\n${JSON.stringify({ workflow: wf })}`));
        expect(got).toEqual({ workflow: wf, workflowId: 7, error: null });
    });

    it("returns only the id when the result has no draft, so the view can fetch it", () => {
        const got = readWorkflow(result(`API Response (Status: 200):\n${JSON.stringify({ workflow_id: 9, revision: "x" })}`));
        expect(got).toEqual({ workflow: null, workflowId: 9, error: null });
    });

    it("surfaces a tool error instead of drawing a stale graph", () => {
        const got = readWorkflow({ isError: true, content: [{ type: "text", text: "API Error (409): revision is stale" }] });
        expect(got).toEqual({ workflow: null, workflowId: null, error: "API Error (409): revision is stale" });
    });

    it("treats a non-JSON body as an error", () => {
        expect(readWorkflow(result("(Status: 204 - No body content)")).error).toBe("(Status: 204 - No body content)");
    });
});
