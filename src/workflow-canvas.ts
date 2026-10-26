// MCP Apps view (ui:// resource) that draws a workflow draft inside the chat.
// The page holds no API key: every read and edit goes back through this
// server's own tools via the host, so it runs on the user's existing login.

export const WORKFLOW_CANVAS_URI = "ui://omnidim/workflow-canvas";

const CANVAS_TOOLS = new Set(["getWorkflow", "createWorkflow", "editWorkflow"]);

export function toolMeta(name: string): { ui: { resourceUri: string } } | undefined {
    return CANVAS_TOOLS.has(name) ? { ui: { resourceUri: WORKFLOW_CANVAS_URI } } : undefined;
}

interface ToolResult { isError?: boolean; content?: Array<{ type: string; text?: string }>; }

// Embedded into the page with toString(), so it must not reference anything outside itself.
export function readWorkflow(result: ToolResult): { workflow: any; workflowId: number | null; error: string | null } {
    const text = (result.content || []).filter((c) => c.type === "text").map((c) => c.text || "").join("\n");
    if (result.isError) return { workflow: null, workflowId: null, error: text };
    const body = text.startsWith("API Response") ? text.slice(text.indexOf("\n") + 1) : text;
    let data: any;
    try { data = JSON.parse(body); } catch { return { workflow: null, workflowId: null, error: text }; }
    const wf = data && (data.workflow || data);
    const id = wf && (wf.id ?? wf.workflow_id);
    const workflowId = typeof id === "number" ? id : null;
    return { workflow: wf && wf.draft ? wf : null, workflowId, error: null };
}

export const WORKFLOW_CANVAS_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Workflow canvas</title>
<style>
:root {
  --bg: #f7f6f2; --panel: #ffffff; --ink: #1d1c19; --muted: #6b675e; --line: #d9d5ca;
  --edge: #9a9486; --grid: #e8e4da; --sel: #2f5bd3; --err: #b3261e;
  --trigger: #2e7d4f; --logic: #b26a00; --voice: #6a3fb5; --msg: #0f7b74; --mail: #2f5bd3; --other: #5f5b52;
  color-scheme: light;
}
:root[data-theme="dark"] {
  --bg: #17161a; --panel: #211f25; --ink: #ecebe6; --muted: #a29e94; --line: #3a3741;
  --edge: #7d7888; --grid: #24222a; --sel: #8aa8ff; --err: #ff8a80;
  --trigger: #6fcf97; --logic: #f2b84b; --voice: #b49cf0; --msg: #5fd3c7; --mail: #8aa8ff; --other: #b0aba1;
  color-scheme: dark;
}
* { box-sizing: border-box; }
body { margin: 0; font: 13px/1.4 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif; color: var(--ink); background: var(--bg); }
header { display: flex; align-items: center; gap: 8px; padding: 10px 12px; border-bottom: 1px solid var(--line); flex-wrap: wrap; }
header h1 { font-size: 14px; margin: 0; font-weight: 600; flex: 1 1 200px; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.pill { font-size: 11px; padding: 2px 8px; border-radius: 999px; border: 1px solid var(--line); color: var(--muted); white-space: nowrap; }
button { font: inherit; font-size: 12px; color: var(--ink); background: var(--panel); border: 1px solid var(--line); border-radius: 6px; padding: 4px 10px; cursor: pointer; }
button:hover { border-color: var(--edge); }
button:focus-visible { outline: 2px solid var(--sel); outline-offset: 1px; }
#stage { overflow: auto; background-color: var(--bg); background-image: radial-gradient(var(--grid) 1px, transparent 1px); background-size: 16px 16px; }
:root[data-mode="fullscreen"] #stage { max-height: none; height: calc(100vh - 160px); }
svg { display: block; touch-action: none; }
.node rect.card { fill: var(--panel); stroke: var(--line); stroke-width: 1; }
.node.selected rect.card { stroke: var(--sel); stroke-width: 2; }
.node { cursor: grab; }
.node.dragging { cursor: grabbing; opacity: .85; }
.node .label { font-size: 13px; font-weight: 600; fill: var(--ink); }
.node .type { font-size: 11px; fill: var(--muted); font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
.edge { fill: none; stroke: var(--edge); stroke-width: 1.5; }
.handle-label { font-size: 11px; fill: var(--muted); paint-order: stroke; stroke: var(--bg); stroke-width: 4px; }
#detail { padding: 10px 12px; border-top: 1px solid var(--line); min-height: 44px; }
#detail .row { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
#detail pre { margin: 8px 0 0; padding: 8px; background: var(--panel); border: 1px solid var(--line); border-radius: 6px; max-height: 180px; overflow: auto; font-size: 11px; }
.muted { color: var(--muted); }
#status { font-size: 12px; color: var(--muted); }
#status.error { color: var(--err); }
</style>
</head>
<body>
<header>
  <h1 id="title">Loading workflow</h1>
  <span class="pill" id="state" hidden></span>
  <button id="refresh" type="button">Refresh</button>
  <button id="full" type="button">Full screen</button>
  <button id="open" type="button">Open in dashboard</button>
</header>
<div id="stage"><svg id="canvas" role="img" aria-label="Workflow graph"></svg></div>
<div id="detail">
  <div id="status">Waiting for the workflow.</div>
  <div id="node" hidden>
    <div class="row"><strong id="n-label"></strong><span class="pill" id="n-type"></span><span class="muted" id="n-id"></span>
      <button id="ask" type="button">Ask Claude about this node</button></div>
    <pre id="n-config"></pre>
  </div>
</div>
<script>
const readWorkflow = ${readWorkflow.toString()};
const NODE_W = 210, NODE_H = 58, PAD = 40, MIN_SCALE = 0.45;
const SVG_NS = "http://www.w3.org/2000/svg";
const $ = (id) => document.getElementById(id);
const state = { wf: null, id: null, selected: null, busy: false };

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

function setStatus(text, isError) {
  $("status").textContent = text;
  $("status").className = isError ? "error" : "";
}

async function callTool(name, args) {
  return request("tools/call", { name, arguments: args });
}

async function refresh() {
  if (state.id == null || state.busy) return;
  state.busy = true; setStatus("Loading the latest draft.");
  try { applyResult(await callTool("getWorkflow", { workflow_id: state.id })); }
  catch (e) { setStatus("Could not load the workflow: " + e.message, true); }
  finally { state.busy = false; }
}

function applyResult(result) {
  const r = readWorkflow(result || {});
  if (r.error) { setStatus(r.error, true); return; }
  if (r.workflowId != null) state.id = r.workflowId;
  if (!r.workflow) { refresh(); return; }
  state.wf = r.workflow;
  render();
  setStatus("Drag a node to move it. Select a node to see its settings.");
}

function accent(type) {
  if (type === "trigger" || type.endsWith("_trigger")) return "var(--trigger)";
  if (type.endsWith("_condition") || type === "switch" || type === "delay" || type === "code") return "var(--logic)";
  if (type.startsWith("voice")) return "var(--voice)";
  if (type.includes("whatsapp") || type.includes("sms")) return "var(--msg)";
  if (type.includes("email")) return "var(--mail)";
  return "var(--other)";
}

function el(tag, attrs, text) {
  const e = document.createElementNS(SVG_NS, tag);
  for (const k in attrs) e.setAttribute(k, attrs[k]);
  if (text != null) e.textContent = text;
  return e;
}

function clip(s, n) { return s.length > n ? s.slice(0, n - 1) + "\\u2026" : s; }

function render() {
  const wf = state.wf, draft = wf.draft, svg = $("canvas");
  $("title").textContent = wf.name || "Workflow " + wf.id;
  $("state").hidden = false;
  $("state").textContent = (wf.status || "draft") + " \\u00b7 " + draft.nodes.length + " nodes";
  const pos = {};
  draft.nodes.forEach((n, i) => { pos[n.id] = n.position || { x: i * 260, y: 0 }; });
  const xs = Object.values(pos).map((p) => p.x), ys = Object.values(pos).map((p) => p.y);
  const minX = Math.min(...xs, 0) - PAD, minY = Math.min(...ys, 0) - PAD;
  const w = Math.max(...xs, 0) + NODE_W + PAD - minX, h = Math.max(...ys, 0) + NODE_H + PAD - minY;
  const avail = $("stage").clientWidth || 600;
  const scale = Math.max(MIN_SCALE, Math.min(1, avail / w));
  svg.setAttribute("viewBox", minX + " " + minY + " " + w + " " + h);
  svg.setAttribute("width", Math.round(w * scale));
  svg.setAttribute("height", Math.round(h * scale));
  svg.replaceChildren();

  const edges = el("g", {});
  for (const e of draft.edges) {
    const a = pos[e.from], b = pos[e.to];
    if (!a || !b) continue;
    const x1 = a.x + NODE_W, y1 = a.y + NODE_H / 2, x2 = b.x, y2 = b.y + NODE_H / 2, dx = Math.max(40, (x2 - x1) / 2);
    edges.append(el("path", { class: "edge", d: "M" + x1 + "," + y1 + " C" + (x1 + dx) + "," + y1 + " " + (x2 - dx) + "," + y2 + " " + x2 + "," + y2, "marker-end": "url(#arrow)" }));
    if (e.handle && e.handle !== "default") {
      edges.append(el("text", { class: "handle-label", x: x2 - 8, y: y2 - 8, "text-anchor": "end" }, e.handle));
    }
  }
  const defs = el("defs", {});
  const marker = el("marker", { id: "arrow", viewBox: "0 0 10 10", refX: "9", refY: "5", markerWidth: "7", markerHeight: "7", orient: "auto-start-reverse" });
  marker.append(el("path", { d: "M0,0 L10,5 L0,10 z", fill: "var(--edge)" }));
  defs.append(marker);
  svg.append(defs, edges);

  for (const n of draft.nodes) {
    const p = pos[n.id];
    const g = el("g", { class: "node" + (state.selected === n.id ? " selected" : ""), transform: "translate(" + p.x + "," + p.y + ")", tabindex: "0", role: "button", "aria-label": (n.label || n.id) + ", " + n.type });
    g.append(el("rect", { class: "card", width: NODE_W, height: NODE_H, rx: 8 }));
    g.append(el("rect", { width: 4, height: NODE_H - 16, x: 0, y: 8, rx: 2, fill: accent(n.type) }));
    g.append(el("text", { class: "label", x: 14, y: 24 }, clip(n.label || n.id, 26)));
    g.append(el("text", { class: "type", x: 14, y: 43 }, clip(n.type, 30)));
    g.addEventListener("pointerdown", (ev) => startDrag(ev, n, g, p));
    g.addEventListener("keydown", (ev) => { if (ev.key === "Enter" || ev.key === " ") { ev.preventDefault(); select(n.id); } });
    svg.append(g);
  }
  if (state.selected) showNode(draft.nodes.find((n) => n.id === state.selected));
}

function toSvg(ev) {
  const svg = $("canvas"), pt = svg.createSVGPoint();
  pt.x = ev.clientX; pt.y = ev.clientY;
  return pt.matrixTransform(svg.getScreenCTM().inverse());
}

function startDrag(ev, node, g, p) {
  if (state.busy) return;
  const start = toSvg(ev), origin = { x: p.x, y: p.y };
  let moved = false;
  g.setPointerCapture(ev.pointerId);
  const move = (e) => {
    const cur = toSvg(e), dx = cur.x - start.x, dy = cur.y - start.y;
    if (!moved && Math.hypot(dx, dy) < 4) return;
    moved = true; g.classList.add("dragging");
    p.x = Math.round(origin.x + dx); p.y = Math.round(origin.y + dy);
    g.setAttribute("transform", "translate(" + p.x + "," + p.y + ")");
  };
  const up = () => {
    g.removeEventListener("pointermove", move);
    g.removeEventListener("pointerup", up);
    g.classList.remove("dragging");
    if (!moved) { select(node.id); return; }
    saveMove(node, { x: p.x, y: p.y }, origin);
  };
  g.addEventListener("pointermove", move);
  g.addEventListener("pointerup", up);
}

async function saveMove(node, position, origin) {
  state.busy = true; setStatus("Saving the new position.");
  try {
    const res = await callTool("editWorkflow", { workflow_id: state.id, requestBody: { revision: state.wf.draft.revision, ops: [{ op: "move_node", id: node.id, position }] } });
    const r = readWorkflow(res || {});
    if (r.error) throw new Error(r.error);
    node.position = position;
    notify("ui/update-model-context", { content: [{ type: "text", text: "The user moved node \\"" + node.id + "\\" on workflow " + state.id + " in the canvas. Call getWorkflow for the new revision before your next edit." }] });
  } catch (e) {
    node.position = origin;
    setStatus("Not saved: " + e.message, true);
    state.busy = false; render(); return;
  }
  state.busy = false;
  await refresh();
}

function select(id) {
  state.selected = id;
  render();
  const n = state.wf.draft.nodes.find((x) => x.id === id);
  notify("ui/update-model-context", { content: [{ type: "text", text: "In the workflow canvas the user selected node \\"" + id + "\\" (" + n.type + ") on workflow " + state.id + "." }] });
}

function showNode(n) {
  if (!n) { $("node").hidden = true; return; }
  $("node").hidden = false;
  $("n-label").textContent = n.label || n.id;
  $("n-type").textContent = n.type;
  $("n-id").textContent = "id " + n.id;
  $("n-config").textContent = n.config ? JSON.stringify(n.config, null, 2) : "Settings are not loaded in this view.";
}

$("refresh").addEventListener("click", refresh);
$("full").addEventListener("click", async () => {
  const mode = document.documentElement.dataset.mode === "fullscreen" ? "inline" : "fullscreen";
  try { const r = await request("ui/request-display-mode", { mode }); applyContext({ displayMode: r && r.mode }); render(); }
  catch (e) { setStatus("This app cannot change size: " + e.message, true); }
});
$("open").addEventListener("click", () => {
  if (state.id != null) request("ui/open-link", { url: "https://omnidim.io/workflow/" + state.id }).catch(() => {});
});
$("ask").addEventListener("click", () => {
  const n = state.wf && state.wf.draft.nodes.find((x) => x.id === state.selected);
  if (!n) return;
  request("ui/message", { role: "user", content: [{ type: "text", text: "In workflow " + state.id + ", explain the \\"" + (n.label || n.id) + "\\" node (id " + n.id + ", " + n.type + ") and check its settings for problems." }] }).catch((e) => setStatus(e.message, true));
});

new ResizeObserver(() => notify("ui/notifications/size-changed", { width: document.documentElement.scrollWidth, height: document.documentElement.scrollHeight })).observe(document.body);

request("ui/initialize", {
  protocolVersion: "2026-01-26",
  appInfo: { name: "omnidim-workflow-canvas", version: "0.1.0" },
  appCapabilities: { availableDisplayModes: ["inline", "fullscreen"] },
}).then((r) => {
  applyContext(r && r.hostContext);
  notify("ui/notifications/initialized", {});
}).catch((e) => setStatus("The host did not accept the view: " + e.message, true));
</script>
</body>
</html>
`;
