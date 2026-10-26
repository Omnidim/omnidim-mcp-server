import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { getResourceText, listResources } from "../src/procedures.js";
import { WORKFLOW_CANVAS_URI, addShowWorkflow, editArgs, errorText, readWorkflow, toolMeta } from "../src/workflow-canvas.js";

const result = (text: string) => ({ content: [{ type: "text", text }] });
const draft = { version_id: 1, revision: "abc", nodes: [{ id: "trigger", type: "trigger" }], edges: [] };

describe("workflow canvas tool link", () => {
    it("draws the canvas only from showWorkflow, so a build does not post one canvas per step", () => {
        expect(toolMeta("showWorkflow")).toEqual({ ui: { resourceUri: WORKFLOW_CANVAS_URI } });
        for (const name of ["getWorkflow", "createWorkflow", "editWorkflow", "listWorkflows", "dispatchCall"]) {
            expect(toolMeta(name), name).toBeUndefined();
        }
    });

    it("is applied in the generated tools/list handler", () => {
        const src = readFileSync(resolve(__dirname, "../src/index.ts"), "utf8");
        expect(src).toContain("_meta: toolMeta(def.name)");
        expect(src).toContain("addShowWorkflow(toolDefinitionMap);");
    });
});

describe("showWorkflow tool", () => {
    const getWorkflow = {
        name: "getWorkflow", description: "x", method: "get", pathTemplate: "/workflows/{workflow_id}",
        inputSchema: { type: "object", properties: { workflow_id: { type: "number" }, view: { type: "string" } }, required: ["workflow_id"] },
        executionParameters: [{ name: "workflow_id", in: "path" }, { name: "view", in: "query" }],
    };

    it("reads the same endpoint as getWorkflow with only a workflow id", () => {
        const map = new Map([["getWorkflow", getWorkflow]]);
        addShowWorkflow(map);
        const show = map.get("showWorkflow")!;
        expect(show.pathTemplate).toBe("/workflows/{workflow_id}");
        expect(show.method).toBe("get");
        expect(show.inputSchema.required).toEqual(["workflow_id"]);
        expect(Object.keys(show.inputSchema.properties)).toEqual(["workflow_id"]);
        expect(show.executionParameters).toEqual([{ name: "workflow_id", in: "path" }]);
        expect(map.get("getWorkflow")).toBe(getWorkflow);
    });

    it("does nothing when getWorkflow is missing", () => {
        const map = new Map<string, typeof getWorkflow>();
        addShowWorkflow(map);
        expect(map.size).toBe(0);
    });
});

describe("workflow canvas resource", () => {
    it("is served as an MCP App view", () => {
        const r = listResources().find((x) => x.uri === WORKFLOW_CANVAS_URI);
        expect(r?.mimeType).toBe("text/html;profile=mcp-app");
        expect(WORKFLOW_CANVAS_URI.startsWith("ui://")).toBe(true);
    });

    it("ships working, self-contained helpers inside the page", () => {
        const html = getResourceText(WORKFLOW_CANVAS_URI) ?? "";
        expect(html).toContain("ui/initialize");
        const pick = (name: string) => {
            const src = html.match(new RegExp(`const ${name} = (function[\\s\\S]*?\\n});`))?.[1] ?? "";
            return new Function(`return (${src});`)();
        };
        const body = JSON.stringify({ workflow: { id: 3, draft } });
        expect(pick("readWorkflow")(result(body)).workflowId).toBe(3);
        expect(pick("editArgs")(3, "r1", []).revision).toBe("r1");
        expect(pick("errorText")('{"error_description":"Nope."}')).toBe("Nope.");
    });

    it("ships no test-only switches", () => {
        expect(getResourceText(WORKFLOW_CANVAS_URI)).not.toContain("VARIANT");
    });
});

describe("canvas page security", () => {
    const html = getResourceText(WORKFLOW_CANVAS_URI) ?? "";
    const script = html.slice(html.indexOf("<script>"), html.indexOf("</script>"));

    it("ships a page script that parses", () => {
        expect(() => new Function(script.slice("<script>".length))).not.toThrow();
    });

    it("calls only the three workflow tools, by literal name", () => {
        const calls = [...script.matchAll(/(?<!function )callTool\(([^,]+),/g)].map((m) => m[1].trim());
        expect(calls.length).toBeGreaterThan(0);
        for (const c of calls) expect(['"getWorkflow"', '"validateWorkflow"', '"editWorkflow"']).toContain(c);
    });

    it("loads nothing from the network and links only to the dashboard", () => {
        const urls = [...html.matchAll(/https?:\/\/[^\s"'<>)]+/g)].map((m) => m[0]);
        for (const u of urls) expect(["http://www.w3.org/2000/svg", "https://omnidim.io/workflow/"]).toContain(u);
        expect(script).not.toMatch(/\bfetch\(|XMLHttpRequest|WebSocket|importScripts|<script src|<link /);
    });

    it("never turns workflow data into markup or code", () => {
        expect(script.match(/innerHTML/g)).toEqual(["innerHTML"]);
        expect(script).toContain("icon.innerHTML = ICONS[iconFor(n.type)];");
        expect(script).not.toMatch(/\beval\(|new Function|document\.write|insertAdjacentHTML|outerHTML/);
    });

    it("only trusts messages from the chat app that embeds it", () => {
        expect(script).toContain("if (event.source !== window.parent) return;");
    });
});

describe("readWorkflow", () => {
    it("reads the workflow from a getWorkflow result", () => {
        const wf = { id: 7, name: "Router", status: "draft", draft };
        const got = readWorkflow(result(`API Response (Status: 200):\n${JSON.stringify({ workflow: wf })}`));
        expect(got).toEqual({ workflow: wf, workflowId: 7, issues: [], error: null });
    });

    it("keeps validation errors so the canvas can mark the nodes", () => {
        const errors = [{ node: "wa_warm", field: "template_id", message: "'template_id' is required." }];
        const got = readWorkflow(result(JSON.stringify({ workflow: { id: 1, draft }, issues: { errors, warnings: [] } })));
        expect(got.issues).toEqual(errors);
    });

    it("reads validateWorkflow's errors the same way", () => {
        const errors = [{ node: "wa_warm", message: "'template_id' is required." }];
        expect(readWorkflow(result(JSON.stringify({ errors, warnings: [] }))).issues).toEqual(errors);
    });

    it("returns only the id when the result has no draft, so the view can fetch it", () => {
        const got = readWorkflow(result(`API Response (Status: 200):\n${JSON.stringify({ workflow_id: 9, revision: "x" })}`));
        expect(got).toEqual({ workflow: null, workflowId: 9, issues: [], error: null });
    });

    it("surfaces a tool error instead of drawing a stale graph", () => {
        const got = readWorkflow({ isError: true, content: [{ type: "text", text: "API Error (409): revision is stale" }] });
        expect(got).toEqual({ workflow: null, workflowId: null, issues: [], error: "API Error (409): revision is stale" });
    });

    it("treats a non-JSON body as an error", () => {
        expect(readWorkflow(result("(Status: 204 - No body content)")).error).toBe("(Status: 204 - No body content)");
    });
});

describe("editArgs", () => {
    it("sends the edit flat for the hosted server and wrapped for this one", () => {
        const ops = [{ op: "move_node", id: "a", position: { x: 1, y: 2 } }];
        expect(editArgs(5, "rev1", ops)).toEqual({
            workflow_id: 5, revision: "rev1", ops, requestBody: { revision: "rev1", ops },
        });
    });
});

describe("errorText", () => {
    it("shows the API's sentence, not the JSON", () => {
        const raw = 'API Error (400): {"error":"invalid_request","error_description":"revision is required. Read the workflow to get it.","code":"missing_fields"}';
        expect(errorText(raw)).toBe("revision is required. Read the workflow to get it.");
    });

    it("falls back to a short plain message", () => {
        expect(errorText("x".repeat(500)).length).toBeLessThanOrEqual(160);
    });
});
