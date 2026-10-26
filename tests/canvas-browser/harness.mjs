// Shared helpers for the canvas browser suites.
export const WF = 101;

export function api(base) {
    const ctl = (path) => fetch(base + path).then((r) => r.text());
    const seen = () => fetch(base + "/seen").then((r) => r.json());
    const rpc = (method, params) => fetch(base + "/mcp", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    }).then((r) => r.json());
    const body = (r) => JSON.parse(r.result.content[0].text.split("\n").slice(1).join("\n"));
    const draft = async () => body(await rpc("tools/call", { name: "getWorkflow", arguments: { workflow_id: WF } })).workflow.draft;
    const posOf = async (id) => (await draft()).nodes.find((n) => n.id === id).position;
    // What Claude does between the canvas's reads: an edit with the current revision.
    const claudeEdits = async (ops) => {
        const { revision } = await draft();
        await rpc("tools/call", { name: "editWorkflow", arguments: { workflow_id: WF, revision, ops, requestBody: { revision, ops } } });
    };
    const setWorkflow = (workflow, issues) => fetch(base + "/set", { method: "POST", body: JSON.stringify({ workflow, issues }) });
    return { ctl, seen, rpc, draft, posOf, claudeEdits, setWorkflow };
}

// Opens the host page with the canvas and collects page errors from both frames.
export async function openCanvas(browser, base, { query = "", theme = "light", viewport = { width: 900, height: 1000 } } = {}) {
    const page = await browser.newPage({ viewport, colorScheme: theme });
    const errors = [];
    page.on("pageerror", (e) => errors.push(String(e)));
    page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
    await page.goto(`${base}/?wf=${WF}&theme=${theme}${query}`);
    const app = page.frameLocator("#app");
    const frame = () => page.frames().find((x) => x !== page.mainFrame());
    const node = (label) => app.locator(`g.node[aria-label^="${label}"]`);
    // Selecting a node opens the panel, and the host resizes the frame a moment later. Clicking a panel
    // button before the height holds still lands where the button used to be.
    const pick = async (label) => {
        await node(label).click();
        let h = -1;
        for (let i = 0; i < 20; i++) {
            const nh = await page.locator("#app").evaluate((f) => f.offsetHeight);
            if (nh === h) break;
            h = nh;
            await page.waitForTimeout(100);
        }
    };
    return { page, app, frame, node, pick, errors };
}
