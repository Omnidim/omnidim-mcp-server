// MCP Apps view (ui:// resource) that shows and edits a workflow draft inside the chat.
// The page holds no API key: every read and edit goes back through this
// server's own tools via the host, so it runs on the user's existing login.

import { createHash } from "node:crypto";

// Where the canvas lived before its address carried a hash. Chats that showed it still ask for it there.
export const LEGACY_CANVAS_URI = "ui://omnidim/workflow-canvas";

// Only showWorkflow draws the canvas. Linking get/create/edit posted one canvas per build step.
export function toolMeta(name: string): { ui: { resourceUri: string } } | undefined {
    return name === "showWorkflow" ? { ui: { resourceUri: WORKFLOW_CANVAS_URI } } : undefined;
}

const SHOW_WORKFLOW_DESCRIPTION = `Show a workflow to the user as an interactive canvas in the chat, where they can move, rename, edit and delete nodes. Call it when the user asks to see a workflow, and once after you finish building or changing one. Do not call it before every edit: use \`getWorkflow\` to read the draft.

(Tags: Workflows)`;

interface ToolDef {
    name: string;
    description: string;
    inputSchema: any;
    executionParameters: Array<{ name: string; in: string }>;
}

// showWorkflow reads the same endpoint as getWorkflow; it exists so the canvas has one trigger.
export function addShowWorkflow<T extends ToolDef>(map: Map<string, T>): void {
    const get = map.get("getWorkflow");
    if (!get) return;
    map.set("showWorkflow", {
        ...get,
        name: "showWorkflow",
        description: SHOW_WORKFLOW_DESCRIPTION,
        inputSchema: {
            type: "object",
            properties: { workflow_id: get.inputSchema.properties.workflow_id },
            required: ["workflow_id"],
        },
        executionParameters: get.executionParameters.filter((p) => p.name === "workflow_id"),
    });
}

interface ToolResult { isError?: boolean; content?: Array<{ type: string; text?: string }>; }

// The three helpers below are embedded into the page with toString(), so they must not
// reference anything outside themselves.
export function readWorkflow(result: ToolResult): { workflow: any; workflowId: number | null; issues: any[]; error: string | null } {
    const text = (result.content || []).filter((c) => c.type === "text").map((c) => c.text || "").join("\n");
    if (result.isError) return { workflow: null, workflowId: null, issues: [], error: text };
    const body = text.startsWith("API Response") ? text.slice(text.indexOf("\n") + 1) : text;
    let data: any;
    try { data = JSON.parse(body); } catch { return { workflow: null, workflowId: null, issues: [], error: text }; }
    const wf = data && (data.workflow || data);
    const id = wf && (wf.id ?? wf.workflow_id);
    const workflowId = typeof id === "number" ? id : null;
    const src = data && data.issues ? data.issues : data;
    const issues = src && Array.isArray(src.errors) ? src.errors : [];
    return { workflow: wf && wf.draft ? wf : null, workflowId, issues, error: null };
}

// The hosted server takes edit fields flat; the npm server takes them under requestBody.
// Each drops the shape it does not use, and the API ignores the extra key.
export function editArgs(workflowId: number, revision: string, ops: any[]): Record<string, unknown> {
    return { workflow_id: workflowId, revision, ops, requestBody: { revision, ops } };
}

export function errorText(text: string): string {
    const start = text.indexOf("{");
    if (start >= 0) {
        try {
            const data = JSON.parse(text.slice(start));
            const msg = data.error_description || data.message || data.detail || data.error;
            if (typeof msg === "string" && msg) return msg;
        } catch { /* not JSON: fall through to the plain text */ }
    }
    return text.length > 160 ? text.slice(0, 157) + "..." : text;
}

// Icon shapes copied from lucide (the set the dashboard's workflow editor uses).
const ICONS: Record<string, string> = {
    zap: '<path d="M4 14a1 1 0 0 1-.78-1.63l9.9-10.2a.5.5 0 0 1 .86.46l-1.92 6.02A1 1 0 0 0 13 10h7a1 1 0 0 1 .78 1.63l-9.9 10.2a.5.5 0 0 1-.86-.46l1.92-6.02A1 1 0 0 0 11 14z"/>',
    phone: '<path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z"/>',
    clock: '<circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>',
    branch: '<line x1="6" x2="6" y1="3" y2="15"/><circle cx="18" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><path d="M18 9a9 9 0 0 1-9 9"/>',
    mail: '<rect width="20" height="16" x="2" y="4" rx="2"/><path d="m22 7-8.97 5.7a1.94 1.94 0 0 1-2.06 0L2 7"/>',
    globe: '<circle cx="12" cy="12" r="10"/><path d="M12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 0-20"/><path d="M2 12h20"/>',
    braces: '<path d="M8 3H7a2 2 0 0 0-2 2v5a2 2 0 0 1-2 2 2 2 0 0 1 2 2v5c0 1.1.9 2 2 2h1"/><path d="M16 21h1a2 2 0 0 0 2-2v-5c0-1.1.9-2 2-2a2 2 0 0 1-2-2V5a2 2 0 0 0-2-2h-1"/>',
    workflow: '<rect width="8" height="8" x="3" y="3" rx="2"/><path d="M7 11v4a2 2 0 0 0 2 2h4"/><rect width="8" height="8" x="13" y="13" rx="2"/>',
    message: '<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>',
    sparkles: '<path d="M9.937 15.5A2 2 0 0 0 8.5 14.063l-6.135-1.582a.5.5 0 0 1 0-.962L8.5 9.936A2 2 0 0 0 9.937 8.5l1.582-6.135a.5.5 0 0 1 .963 0L14.063 8.5A2 2 0 0 0 15.5 9.937l6.135 1.581a.5.5 0 0 1 0 .964L15.5 14.063a2 2 0 0 0-1.437 1.437l-1.582 6.135a.5.5 0 0 1-.963 0z"/>',
    user: '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><line x1="19" x2="19" y1="8" y2="14"/><line x1="22" x2="16" y1="11" y2="11"/>',
    note: '<path d="M16 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V8Z"/><path d="M15 3v4a2 2 0 0 0 2 2h4"/>',
};

export const WORKFLOW_CANVAS_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Workflow canvas</title>
<style>
/* Colors follow the dashboard's workflow editor tokens. */
:root {
  --bg: hsl(210 30% 96%); --card: hsl(210 30% 99%); --fg: hsl(222 47% 9%); --muted: hsl(215 19% 36%);
  --line: hsl(214 25% 87%); --edge: #94a3b8; --dot: hsl(214 25% 84%); --primary: hsl(172.5 66% 40.4%);
  --primary-soft: hsl(172.5 66% 40.4% / .12); --sel: #fbbf24; --err: #dc2626; --err-soft: hsl(0 84% 60% / .08);
  color-scheme: light;
}
:root[data-theme="dark"] {
  --bg: hsl(0 0% 3.9%); --card: hsl(0 0% 7%); --fg: hsl(0 0% 98%); --muted: hsl(0 0% 64%);
  --line: hsl(0 0% 16%); --edge: #64748b; --dot: hsl(0 0% 14%); --primary: hsl(180 100% 35.1%);
  --primary-soft: hsl(180 100% 35.1% / .16); --sel: #fbbf24; --err: #f87171; --err-soft: hsl(0 91% 71% / .1);
  color-scheme: dark;
}
* { box-sizing: border-box; }
body { margin: 0; font: 13px/1.4 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif; color: var(--fg); background: var(--bg); }
header { display: flex; align-items: center; gap: 8px; padding: 10px 12px; border-bottom: 1px solid var(--line); flex-wrap: wrap; background: var(--card); }
header h1 { font-size: 14px; margin: 0; font-weight: 600; flex: 1 1 200px; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.pill { font-size: 11px; padding: 2px 8px; border-radius: 999px; border: 1px solid var(--line); color: var(--muted); white-space: nowrap; }
.pill.bad { color: var(--err); border-color: var(--err); }
button, input, textarea { font: inherit; font-size: 12px; color: var(--fg); }
button { background: var(--card); border: 1px solid var(--line); border-radius: 6px; padding: 4px 10px; cursor: pointer; }
button:hover { border-color: var(--edge); }
button:disabled { opacity: .6; cursor: progress; }
button.danger { color: var(--err); }
button:focus-visible, input:focus-visible, textarea:focus-visible { outline: 2px solid var(--primary); outline-offset: 1px; }
#stage { overflow: auto; background-color: var(--bg); background-image: radial-gradient(var(--dot) 1px, transparent 1px); background-size: 16px 16px; }
:root[data-mode="fullscreen"] #stage { height: calc(100vh - 52px - var(--panel-h, 0px)); }
svg { display: block; touch-action: none; }
.card { fill: var(--card); stroke: var(--line); stroke-width: 1; }
.node:hover .card { stroke: var(--primary); }
.node.selected .card { stroke: var(--sel); stroke-width: 2; }
.node.invalid .card { stroke: var(--err); stroke-width: 1.5; }
.node { cursor: grab; }
.node.dragging { cursor: grabbing; }
.icon-box { fill: var(--primary-soft); }
.icon { fill: none; stroke: var(--primary); stroke-width: 2; stroke-linecap: round; stroke-linejoin: round; }
.label { font-size: 13px; font-weight: 600; fill: var(--fg); }
.sub { font-size: 11.5px; fill: var(--muted); }
.handle { fill: var(--edge); stroke: var(--card); stroke-width: 2; }
.edge { fill: none; stroke: var(--edge); stroke-width: 2; }
.chip rect { fill: var(--card); stroke: var(--line); }
.chip text { font-size: 10px; font-weight: 700; letter-spacing: .04em; fill: var(--muted); text-transform: uppercase; }
.skel { fill: var(--card); stroke: var(--line); }
@media (prefers-reduced-motion: no-preference) { .skel { animation: pulse 1.2s ease-in-out infinite; } }
@keyframes pulse { 50% { opacity: .5; } }
#panel { padding: 10px 12px; border-top: 1px solid var(--line); background: var(--card); display: grid; gap: 8px; }
#panel[hidden] { display: none; }
.row { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
.muted { color: var(--muted); }
#n-label { flex: 1 1 180px; min-width: 0; padding: 4px 8px; border: 1px solid var(--line); border-radius: 6px; background: var(--bg); }
#n-config { width: 100%; min-height: 120px; max-height: 240px; padding: 8px; border: 1px solid var(--line); border-radius: 6px; background: var(--bg); font: 11px/1.45 ui-monospace, SFMono-Regular, Menlo, monospace; resize: vertical; }
#n-errors { color: var(--err); background: var(--err-soft); border-radius: 6px; padding: 6px 8px; font-size: 12px; }
#n-errors[hidden] { display: none; }
#notice { font-size: 12px; color: var(--err); padding: 6px 12px; border-top: 1px solid var(--line); background: var(--err-soft); }
#notice.info { color: var(--muted); background: var(--card); }
#notice[hidden] { display: none; }
</style>
</head>
<body>
<header>
  <h1 id="title">Loading workflow</h1>
  <span class="pill" id="state" hidden></span>
  <span class="pill bad" id="issues" hidden></span>
  <button id="refresh" type="button">Reload</button>
  <button id="full" type="button">Full screen</button>
  <button id="open" type="button">Open in dashboard</button>
</header>
<div id="stage"><svg id="canvas" role="img" aria-label="Workflow graph"></svg></div>
<div id="notice" role="status" hidden></div>
<div id="panel" hidden>
  <div class="row">
    <input id="n-label" aria-label="Node name">
    <span class="pill" id="n-type"></span>
    <span class="muted" id="n-id"></span>
  </div>
  <div id="n-errors" hidden></div>
  <textarea id="n-config" aria-label="Node settings (JSON)" spellcheck="false"></textarea>
  <div class="row">
    <button id="save" type="button">Save changes</button>
    <button id="delete" type="button" class="danger">Delete node</button>
    <button id="ask" type="button">Ask Claude about this node</button>
  </div>
</div>
<script>
const readWorkflow = ${readWorkflow.toString()};
const editArgs = ${editArgs.toString()};
const errorText = ${errorText.toString()};
const ICONS = ${JSON.stringify(ICONS)};
// Card size and handles match the dashboard editor: inputs on top, outputs at the bottom.
const NODE_W = 220, NODE_H = 62, PAD = 40, MIN_SCALE = 0.7, FALLBACK_MS = 800;
const SVG_NS = "http://www.w3.org/2000/svg";
const $ = (id) => document.getElementById(id);
const state = { wf: null, id: null, issues: [], selected: null, busy: false, dirty: false, dragging: false, redraw: false, form: null };

// JSON-RPC over postMessage to the host (MCP Apps protocol 2026-01-26).
let nextId = 1;
const pending = new Map();
function send(msg) { window.parent.postMessage(Object.assign({ jsonrpc: "2.0" }, msg), "*"); }
function request(method, params) {
  const id = nextId++;
  send({ id, method, params });
  return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
}
function notify(method, params) { send({ method, params }); }

window.addEventListener("message", (event) => {
  if (event.source !== window.parent) return;
  const msg = event.data;
  if (!msg || msg.jsonrpc !== "2.0") return;
  if (msg.id !== undefined && pending.has(msg.id) && !msg.method) {
    const p = pending.get(msg.id); pending.delete(msg.id);
    msg.error ? p.reject(new Error(msg.error.message || "Request failed")) : p.resolve(msg.result);
    return;
  }
  if (msg.method === "ui/notifications/tool-input") {
    const id = msg.params && msg.params.arguments && msg.params.arguments.workflow_id;
    if (typeof id === "number") state.id = id;
    // Some hosts hand over the result late; load it ourselves instead of sitting empty.
    setTimeout(() => { if (!state.wf) refresh(); }, FALLBACK_MS);
  } else if (msg.method === "ui/notifications/tool-result") {
    applyResult(msg.params);
  } else if (msg.method === "ui/notifications/host-context-changed") {
    applyContext(msg.params);
  } else if (msg.method === "ui/resource-teardown" && msg.id !== undefined) {
    send({ id: msg.id, result: {} });
  } else if (msg.id !== undefined && msg.method) {
    send({ id: msg.id, error: { code: -32601, message: "Method not found" } });
  }
});

function applyContext(ctx) {
  if (!ctx) return;
  if (ctx.theme) document.documentElement.dataset.theme = ctx.theme;
  if (ctx.displayMode) document.documentElement.dataset.mode = ctx.displayMode;
}

// The bar under the canvas stays hidden unless something needs the user's attention.
function notice(text, kind) {
  const el = $("notice");
  el.hidden = !text;
  el.textContent = text || "";
  el.className = kind === "info" ? "info" : "";
}

function callTool(name, args) { return request("tools/call", { name, arguments: args }); }

async function refresh() {
  if (state.id == null || state.busy) return;
  state.busy = true;
  try {
    const r = readWorkflow(await callTool("getWorkflow", { workflow_id: state.id }));
    if (r.error) notice("Could not load the workflow: " + errorText(r.error));
    else if (r.workflow) show(r.workflow, null);
  } catch (e) { notice("Could not load the workflow: " + e.message); }
  finally { state.busy = false; }
}

function applyResult(result) {
  const r = readWorkflow(result || {});
  if (r.error) { notice(errorText(r.error)); return; }
  if (r.workflowId != null) state.id = r.workflowId;
  if (!r.workflow) { refresh(); return; }
  show(r.workflow, r.issues);
}

function show(wf, issues) {
  state.wf = wf;
  if (issues) state.issues = issues;
  notice("");
  render();
  validate();
}

// getWorkflow carries no problems, so ask validateWorkflow which nodes to mark, like the dashboard does.
async function validate() {
  try {
    const r = readWorkflow(await callTool("validateWorkflow", { workflow_id: state.id }));
    if (!r.error) { state.issues = r.issues; render(); }
  } catch { /* the marks are a hint; the canvas works without them */ }
}

function iconFor(type) {
  if (type === "trigger" || type.endsWith("_trigger") || type.endsWith("_inbound")) return "zap";
  if (type === "voice_ai" || type.includes("dialer")) return "phone";
  if (type === "wait" || type === "wait_for_time" || type === "time_condition") return "clock";
  if (type === "switch_condition" || type === "conditional") return "branch";
  if (type.includes("email")) return "mail";
  if (type === "custom_api") return "globe";
  if (type === "code") return "braces";
  if (type === "sub_workflow") return "workflow";
  if (type.includes("whatsapp") || type.includes("sms") || type === "slack") return "message";
  if (type === "ai_assistant" || type === "photo_analyzer") return "sparkles";
  if (type.includes("contact") || type.includes("crm")) return "user";
  if (type === "notes") return "note";
  return "branch";
}

// Mirrors the subtitles the dashboard editor shows under each node name.
function subtitle(n) {
  const c = n.config || {};
  switch (n.type) {
    case "trigger": return c.webhook_enabled ? "Webhook enabled" : "Configure webhook";
    case "voice_ai": return c.bot_name || (c.bot_id ? "Agent " + c.bot_id : "Choose an agent");
    case "wait": return (c.delay_seconds || 0) + " seconds";
    case "whatsapp": return c.template_name || "Choose a template";
    case "send_email": return c.email_to || "Configure email";
    case "custom_api": return c.url || "Configure request";
    case "switch_condition": return ((c.cases || []).length) + " cases + else";
    case "time_condition": return "Time window";
    case "code": return c.code ? "Python snippet" : "Write a snippet";
    case "sub_workflow": return c.target_workflow_name || "Choose a workflow";
    case "slack": return c.message ? String(c.message).slice(0, 60) : "Configure message";
    default: return n.type;
  }
}

// Workflow text is data, not instructions: one line, capped, quoted, before it goes into the chat.
function quoted(s) { return JSON.stringify(String(s).replace(/\\s+/g, " ").slice(0, 80)); }

function el(tag, attrs, text) {
  const e = document.createElementNS(SVG_NS, tag);
  for (const k in attrs) e.setAttribute(k, attrs[k]);
  if (text != null) e.textContent = text;
  return e;
}

function clip(s, n) { s = String(s); return s.length > n ? s.slice(0, n - 1) + "…" : s; }

function ports(p) {
  return { in: { x: p.x + NODE_W / 2, y: p.y }, out: { x: p.x + NODE_W / 2, y: p.y + NODE_H } };
}

// Right-angle path with rounded corners, like React Flow's smoothstep edge.
function stepPath(a, b) {
  const pts = [a];
  if (b.y - a.y >= 40) { const m = (a.y + b.y) / 2; pts.push({ x: a.x, y: m }, { x: b.x, y: m }); }
  else { const mx = (a.x + b.x) / 2; pts.push({ x: a.x, y: a.y + 20 }, { x: mx, y: a.y + 20 }, { x: mx, y: b.y - 20 }, { x: b.x, y: b.y - 20 }); }
  pts.push(b);
  let d = "M" + pts[0].x + "," + pts[0].y;
  for (let i = 1; i < pts.length - 1; i++) {
    const p = pts[i], prev = pts[i - 1], next = pts[i + 1];
    const r = Math.min(6, Math.hypot(p.x - prev.x, p.y - prev.y) / 2, Math.hypot(next.x - p.x, next.y - p.y) / 2);
    const ux = Math.sign(p.x - prev.x), uy = Math.sign(p.y - prev.y), vx = Math.sign(next.x - p.x), vy = Math.sign(next.y - p.y);
    d += " L" + (p.x - ux * r) + "," + (p.y - uy * r) + " Q" + p.x + "," + p.y + " " + (p.x + vx * r) + "," + (p.y + vy * r);
  }
  d += " L" + b.x + "," + b.y;
  const mid = pts[Math.floor(pts.length / 2)], mid2 = pts[Math.floor(pts.length / 2) - 1];
  return { d, label: { x: (mid.x + mid2.x) / 2, y: (mid.y + mid2.y) / 2 } };
}

function drawEdges(layer) {
  layer.replaceChildren();
  const pos = {};
  for (const n of state.wf.draft.nodes) pos[n.id] = n.position;
  for (const e of state.wf.draft.edges) {
    const a = pos[e.from], b = pos[e.to];
    if (!a || !b) continue;
    const s = stepPath(ports(a).out, ports(b).in);
    layer.append(el("path", { class: "edge", d: s.d, "marker-end": "url(#arrow)" }));
    if (e.handle && e.handle !== "default") {
      const text = clip(e.handle, 18), w = text.length * 6.4 + 14;
      const chip = el("g", { class: "chip", transform: "translate(" + (s.label.x - w / 2) + "," + (s.label.y - 9) + ")" });
      chip.append(el("rect", { width: w, height: 18, rx: 5 }), el("text", { x: 7, y: 12.5 }, text));
      layer.append(chip);
    }
  }
}

function errorsFor(id) { return state.issues.filter((i) => i.node === id); }

function render() {
  if (!state.wf) return;
  // Redrawing replaces the node under the pointer and kills the drag, so wait for the drop.
  if (state.dragging) { state.redraw = true; return; }
  const wf = state.wf, draft = wf.draft, svg = $("canvas");
  $("title").textContent = wf.name || "Workflow " + wf.id;
  $("state").hidden = false;
  $("state").textContent = (wf.status || "draft") + " · " + draft.nodes.length + " nodes";
  $("issues").hidden = !state.issues.length;
  $("issues").textContent = state.issues.length + (state.issues.length === 1 ? " problem" : " problems");
  draft.nodes.forEach((n, i) => { if (!n.position) n.position = { x: i * 260, y: 0 }; });
  const xs = draft.nodes.map((n) => n.position.x), ys = draft.nodes.map((n) => n.position.y);
  const minX = Math.min(...xs, 0) - PAD, minY = Math.min(...ys, 0) - PAD;
  const w = Math.max(...xs, 0) + NODE_W + PAD - minX, h = Math.max(...ys, 0) + NODE_H + PAD - minY;
  const avail = $("stage").clientWidth || 600;
  const scale = Math.max(MIN_SCALE, Math.min(1, avail / w));
  svg.setAttribute("viewBox", minX + " " + minY + " " + w + " " + h);
  svg.setAttribute("width", Math.round(w * scale));
  svg.setAttribute("height", Math.round(h * scale));
  svg.replaceChildren();
  const defs = el("defs", {});
  const marker = el("marker", { id: "arrow", viewBox: "0 0 10 10", refX: "8", refY: "5", markerWidth: "6", markerHeight: "6", orient: "auto-start-reverse" });
  marker.append(el("path", { d: "M0,0 L10,5 L0,10 z", fill: "var(--edge)" }));
  defs.append(marker);
  const edges = el("g", {});
  svg.append(defs, edges);
  drawEdges(edges);

  for (const n of draft.nodes) {
    const bad = errorsFor(n.id).length > 0;
    const cls = "node" + (state.selected === n.id ? " selected" : "") + (bad ? " invalid" : "");
    const g = el("g", { class: cls, transform: "translate(" + n.position.x + "," + n.position.y + ")", tabindex: "0", role: "button", "aria-label": (n.label || n.id) + ", " + n.type + (bad ? ", has problems" : "") });
    g.append(el("rect", { class: "card", width: NODE_W, height: NODE_H, rx: 8 }));
    g.append(el("rect", { class: "icon-box", x: 10, y: 10, width: 24, height: 24, rx: 6 }));
    const icon = el("g", { class: "icon", transform: "translate(15,15) scale(0.5833)" });
    icon.innerHTML = ICONS[iconFor(n.type)];
    g.append(icon);
    g.append(el("text", { class: "label", x: 42, y: 26.5 }, clip(n.label || n.id, 23)));
    g.append(el("text", { class: "sub", x: 12, y: NODE_H - 12 }, clip(subtitle(n), 31)));
    const pt = ports({ x: 0, y: 0 });
    if (!n.type.endsWith("trigger") && !n.type.endsWith("_inbound")) g.append(el("circle", { class: "handle", cx: pt.in.x, cy: pt.in.y, r: 4 }));
    g.append(el("circle", { class: "handle", cx: pt.out.x, cy: pt.out.y, r: 4 }));
    g.addEventListener("pointerdown", (ev) => startDrag(ev, n, g, edges));
    g.addEventListener("keydown", (ev) => { if (ev.key === "Enter" || ev.key === " ") { ev.preventDefault(); select(n.id); } });
    svg.append(g);
  }
  showPanel();
}

function placeholder() {
  const svg = $("canvas");
  svg.setAttribute("viewBox", "0 0 600 240"); svg.setAttribute("width", 600); svg.setAttribute("height", 240);
  svg.replaceChildren();
  [[40, 90], [320, 30], [320, 150]].forEach(([x, y]) => svg.append(el("rect", { class: "skel", x, y, width: 220, height: 62, rx: 8 })));
}

function toSvg(ev) {
  const svg = $("canvas"), pt = svg.createSVGPoint();
  pt.x = ev.clientX; pt.y = ev.clientY;
  return pt.matrixTransform(svg.getScreenCTM().inverse());
}

// The drag is tracked on the whole document, not the node: a release outside the chat's
// frame never reaches the frame, so leaving the frame (or a move with no button held) drops the node there.
function startDrag(ev, node, g, edges) {
  // One drag at a time, primary pointer only: a second finger must not start a drag nobody saves.
  if (state.busy || state.dragging || ev.button !== 0 || !ev.isPrimary) return;
  const start = toSvg(ev), origin = { x: node.position.x, y: node.position.y };
  let moved = false;
  state.dragging = true;
  const move = (e) => {
    if (e.buttons === 0) return up();
    const cur = toSvg(e), dx = cur.x - start.x, dy = cur.y - start.y;
    if (!moved && Math.hypot(dx, dy) < 4) return;
    moved = true; g.classList.add("dragging");
    node.position = { x: Math.round(origin.x + dx), y: Math.round(origin.y + dy) };
    g.setAttribute("transform", "translate(" + node.position.x + "," + node.position.y + ")");
    drawEdges(edges);
  };
  const up = () => {
    document.removeEventListener("pointermove", move);
    document.removeEventListener("pointerup", up);
    document.documentElement.removeEventListener("pointerleave", up);
    window.removeEventListener("blur", up);
    g.classList.remove("dragging");
    if (!state.dragging) return;
    state.dragging = false;
    if (state.redraw) { state.redraw = false; render(); }
    if (!moved) { select(node.id); return; }
    if (node.position.x === origin.x && node.position.y === origin.y) return;
    save([{ op: "move_node", id: node.id, position: node.position }], "moved node " + quoted(node.id), () => { node.position = origin; });
  };
  document.addEventListener("pointermove", move);
  document.addEventListener("pointerup", up);
  document.documentElement.addEventListener("pointerleave", up);
  window.addEventListener("blur", up);
}

// Every edit sends the draft revision, so a stale edit is refused instead of overwriting Claude's.
async function save(ops, what, rollback, button) {
  if (!state.wf) return false;
  if (state.busy) { if (rollback) rollback(); render(); notice("Still loading the workflow. Try again in a moment."); return false; }
  state.busy = true;
  if (button) { button.disabled = true; button.dataset.text = button.textContent; button.textContent = "Saving…"; }
  let ok = false;
  try {
    const r = readWorkflow(await callTool("editWorkflow", editArgs(state.id, state.wf.draft.revision, ops)) || {});
    if (r.error) throw new Error(errorText(r.error));
    ok = true;
    notify("ui/update-model-context", { content: [{ type: "text", text: "In the workflow canvas the user " + what + " on workflow " + state.id + ". Call getWorkflow for the new revision before your next edit." }] });
  } catch (e) {
    if (rollback) rollback();
    notice("Not saved: " + e.message);
  } finally {
    state.busy = false;
    if (button) { button.disabled = false; button.textContent = button.dataset.text; }
  }
  const failure = ok ? "" : $("notice").textContent;
  await refresh();
  if (!ok) notice(failure);
  return ok;
}

function select(id) {
  state.selected = id;
  state.dirty = false;
  render();
  const n = state.wf.draft.nodes.find((x) => x.id === id);
  if (!n) return;
  notify("ui/update-model-context", { content: [{ type: "text", text: "In the workflow canvas the user selected node " + quoted(id) + " (type " + quoted(n.type) + ") on workflow " + state.id + "." }] });
}

function showPanel() {
  const n = state.selected && state.wf.draft.nodes.find((x) => x.id === state.selected);
  $("panel").hidden = !n;
  if (!n) return;
  if (state.dirty && $("panel").dataset.node === n.id) return;
  $("panel").dataset.node = n.id;
  state.dirty = false;
  // What the form was loaded with: the base for working out what the user changed.
  state.form = { id: n.id, label: n.label || "", config: JSON.parse(JSON.stringify(n.config || {})) };
  $("n-label").value = n.label || "";
  $("n-type").textContent = n.type;
  $("n-id").textContent = "id " + n.id;
  $("n-config").value = n.config ? JSON.stringify(n.config, null, 2) : "{}";
  const errs = errorsFor(n.id);
  $("n-errors").hidden = !errs.length;
  $("n-errors").textContent = errs.map((e) => e.message).join(" ");
  $("delete").textContent = "Delete node";
  document.documentElement.style.setProperty("--panel-h", $("panel").offsetHeight + "px");
}

// Typed but unsaved settings survive the refresh that follows a move or another save.
for (const id of ["n-label", "n-config"]) $(id).addEventListener("input", () => { state.dirty = true; });

// Sends only what the user changed since the form loaded. If Claude changed the same field in the
// meantime the save is refused, so neither edit silently overwrites the other.
$("save").addEventListener("click", () => {
  const n = state.wf && state.wf.draft.nodes.find((x) => x.id === state.selected);
  const base = state.form;
  if (!n || !base || base.id !== n.id) return;
  let config;
  try { config = JSON.parse($("n-config").value || "{}"); }
  catch { notice("The settings are not valid JSON. Fix them and save again."); return; }
  if (!config || typeof config !== "object" || Array.isArray(config)) { notice('The settings must be a JSON object, like {"key": "value"}.'); return; }
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  const now = n.config || {}, op = { op: "update_node", id: n.id }, changed = Object.create(null), clash = [];
  for (const k of Object.keys(config)) if (k !== "__proto__" && !same(config[k], base.config[k])) changed[k] = config[k];
  for (const k of Object.keys(base.config)) if (!(k in config)) changed[k] = null;
  for (const k of Object.keys(changed)) if (!same(now[k], base.config[k])) clash.push(k);
  const label = $("n-label").value.trim();
  if (label && label !== base.label) {
    if ((n.label || "") !== base.label) clash.push("name");
    op.label = label;
  }
  if (clash.length) { notice("Claude changed " + clash.join(", ") + " on this node while you were editing. Select the node again to load its version, then redo your change."); return; }
  if (Object.keys(changed).length) op.config = changed;
  if (!op.label && !op.config) { notice("Nothing changed.", "info"); return; }
  save([op], "edited node " + quoted(n.id), null, $("save")).then((ok) => { if (ok) { state.dirty = false; showPanel(); } });
});

$("delete").addEventListener("click", () => {
  const btn = $("delete"), id = state.selected;
  if (!id) return;
  if (btn.textContent !== "Click again to delete") { btn.textContent = "Click again to delete"; return; }
  save([{ op: "delete_node", id }], "deleted node " + quoted(id), null, btn).then((ok) => { if (ok) { state.selected = null; render(); } });
});

$("refresh").addEventListener("click", refresh);
$("full").addEventListener("click", async () => {
  const mode = document.documentElement.dataset.mode === "fullscreen" ? "inline" : "fullscreen";
  try { const r = await request("ui/request-display-mode", { mode }); applyContext({ displayMode: r && r.mode }); render(); }
  catch (e) { notice("Full screen is not available here."); }
});
$("open").addEventListener("click", () => {
  if (state.id != null) request("ui/open-link", { url: "https://omnidim.io/workflow/" + state.id }).catch(() => {});
});
$("ask").addEventListener("click", () => {
  const n = state.wf && state.wf.draft.nodes.find((x) => x.id === state.selected);
  if (!n) return;
  request("ui/message", { role: "user", content: [{ type: "text", text: "In workflow " + state.id + ", explain the node with id " + quoted(n.id) + " (type " + quoted(n.type) + ", named " + quoted(n.label || n.id) + ") and check its settings for problems." }] }).catch(() => notice("Could not send the message to the chat."));
});

new ResizeObserver(() => notify("ui/notifications/size-changed", { width: document.documentElement.scrollWidth, height: document.documentElement.scrollHeight })).observe(document.body);

placeholder();
request("ui/initialize", {
  protocolVersion: "2026-01-26",
  appInfo: { name: "omnidim-workflow-canvas", version: "0.2.0" },
  appCapabilities: { availableDisplayModes: ["inline", "fullscreen"] },
}).then((r) => {
  applyContext(r && r.hostContext);
  notify("ui/notifications/initialized", {});
}).catch(() => notice("This chat app could not open the canvas."));
</script>
</body>
</html>
`;

// Chat apps cache a view by its address, so a changed page needs a new address or users keep the old one.
export const WORKFLOW_CANVAS_URI = `${LEGACY_CANVAS_URI}/${createHash("sha256").update(WORKFLOW_CANVAS_HTML).digest("hex").slice(0, 12)}`;
