// Stands in for the chat app's server side: serves the test host page and the canvas, and answers the
// canvas's tool calls from fixture.json, refusing stale revisions like the real API. No network, no API key.
import { readFileSync } from "node:fs";
import http from "node:http";

import { WORKFLOW_CANVAS_HTML, WORKFLOW_CANVAS_URI } from "../../build/workflow-canvas.js";

const HOST = readFileSync(new URL("host.html", import.meta.url), "utf8");
const FIXTURE = readFileSync(new URL("fixture.json", import.meta.url), "utf8");

export function startServer() {
    let wf, issues, rev, seen, ctl;
    const reset = () => {
        ({ workflow: wf, issues } = JSON.parse(FIXTURE));
        rev = 0; seen = []; ctl = {};
    };
    reset();

    const ok = (body) => ({ content: [{ type: "text", text: "API Response (Status: 200):\n" + JSON.stringify(body) }] });
    const apiError = (status, body) => ({ isError: true, content: [{ type: "text", text: `API Error (${status}): ${JSON.stringify(body)}` }] });
    const pause = async (key) => {
        const ms = ctl[key];
        ctl[key] = 0;
        if (ms) await new Promise((r) => setTimeout(r, ms));
    };

    function edit(a) {
        seen.push(a);
        if (typeof a.revision !== "string" || a.requestBody?.revision !== a.revision) {
            return apiError(400, { error: "invalid_request", error_description: "revision is required. Read the workflow to get it." });
        }
        const d = wf.draft;
        if (a.revision !== d.revision) {
            return apiError(409, { error: "revision_conflict", error_description: "The workflow changed since you read it. Read it again, then retry." });
        }
        for (const op of a.ops) {
            const n = d.nodes.find((x) => x.id === op.id);
            if (op.op === "move_node") n.position = op.position;
            if (op.op === "update_node") {
                if (op.label) n.label = op.label;
                for (const k in op.config || {}) {
                    if (op.config[k] === null) delete n.config[k];
                    else (n.config ||= {})[k] = op.config[k];
                }
            }
            if (op.op === "delete_node") {
                d.nodes = d.nodes.filter((x) => x.id !== op.id);
                d.edges = d.edges.filter((e) => e.from !== op.id && e.to !== op.id);
            }
        }
        d.revision = "r" + ++rev;
        return ok({ workflow_id: wf.id, revision: d.revision });
    }

    async function callTool(name, a) {
        if (a.workflow_id !== wf.id) return apiError(404, { error: "not_found", error_description: "Workflow not found." });
        if (name === "showWorkflow") return ok({ workflow: wf });
        if (name === "getWorkflow") { await pause("slowGet"); return ok({ workflow: wf }); }
        if (name === "validateWorkflow") { await pause("slowValidate"); return ok({ errors: issues, warnings: [] }); }
        if (name === "editWorkflow") {
            await pause("slowEdit");
            if (ctl.fail) { ctl.fail = false; seen.push(a); throw new Error("upstream network error"); }
            return edit(a);
        }
        throw new Error("Unknown tool: " + name);
    }

    async function rpc(msg) {
        if (msg.method === "resources/read" && msg.params.uri === WORKFLOW_CANVAS_URI) {
            return { contents: [{ uri: WORKFLOW_CANVAS_URI, mimeType: "text/html;profile=mcp-app", text: WORKFLOW_CANVAS_HTML }] };
        }
        if (msg.method === "tools/call") return callTool(msg.params.name, msg.params.arguments || {});
        throw new Error("Method not found: " + msg.method);
    }

    // Test controls: the next getWorkflow, validateWorkflow or editWorkflow waits `ms`; the next edit fails.
    const controls = {
        "/reset": () => reset(),
        "/seen": () => seen,
        "/fail-next": () => { ctl.fail = true; },
        "/slow-get": (ms) => { ctl.slowGet = ms; },
        "/slow-validate": (ms) => { ctl.slowValidate = ms; },
        "/slow-edit": (ms) => { ctl.slowEdit = ms; },
    };

    const server = http.createServer(async (req, res) => {
        const url = new URL(req.url, "http://x");
        const chunks = [];
        for await (const c of req) chunks.push(c);
        const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : null;
        if (url.pathname === "/") {
            res.setHeader("content-type", "text/html");
            return res.end(HOST);
        }
        if (url.pathname === "/set") {
            ({ workflow: wf, issues } = body);
            return res.end("ok");
        }
        if (controls[url.pathname]) {
            const out = controls[url.pathname](Number(url.searchParams.get("ms") || 1500));
            return res.end(JSON.stringify(out ?? "ok"));
        }
        if (url.pathname === "/mcp") {
            res.setHeader("content-type", "application/json");
            try { return res.end(JSON.stringify({ jsonrpc: "2.0", id: body.id, result: await rpc(body) })); }
            catch (e) { return res.end(JSON.stringify({ jsonrpc: "2.0", id: body.id, error: { code: -32603, message: e.message } })); }
        }
        res.statusCode = 404;
        res.end();
    });
    return new Promise((resolve) => server.listen(0, "127.0.0.1", () => {
        resolve({ url: `http://127.0.0.1:${server.address().port}`, close: () => server.close() });
    }));
}
