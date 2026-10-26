// Loading, drawing, a move, a conflict, panel edits and delete, in one session like a user's.
import { api, openCanvas } from "./harness.mjs";

export default async function general({ browser, base, check }) {
    const { seen, draft, claudeEdits } = api(base);

    // A host that hands the result over 5s late: placeholder first, Full screen works, graph loads itself.
    {
        const { page, app, errors } = await openCanvas(browser, base, { query: "&delay=5000" });
        await page.waitForTimeout(300);
        check("late result: placeholder cards shown while loading", (await app.locator(".skel").count()) === 3);
        await app.locator("#full").click();
        await page.waitForTimeout(150);
        check("late result: Full screen before load shows no error", await app.locator("#notice").isHidden(), await app.locator("#notice").textContent());
        const loaded = await app.locator("g.node").first().waitFor({ timeout: 2500 }).then(() => true, () => false);
        check("late result: graph loads itself within 2.5s", loaded);
        check("late result: no page errors", errors.length === 0, errors.join(" | "));
        await page.close();
    }

    const { page, app, pick, errors } = await openCanvas(browser, base);
    await app.locator("g.node").first().waitFor({ timeout: 10000 });
    await app.locator("g.node.invalid").first().waitFor({ timeout: 5000 }).catch(() => {});
    check("load: bottom bar hidden when nothing failed", await app.locator("#notice").isHidden());
    check("load: node with validation errors has a red border", (await app.locator('g.node.invalid[aria-label^="WhatsApp (warm)"]').count()) === 1);
    check("load: header counts the problems", ((await app.locator("#issues").textContent()) || "").includes("2 problems"));

    // Drag: arrows follow during the drag; the edit carries the revision in both argument shapes.
    const edgeBefore = await app.locator("path.edge").first().getAttribute("d");
    const box = await app.locator('g.node[aria-label^="Webhook In"]').boundingBox();
    await page.mouse.move(box.x + 30, box.y + 15);
    await page.mouse.down();
    await page.mouse.move(box.x + 30, box.y + 115, { steps: 6 });
    check("drag: arrows follow the node while dragging", (await app.locator("path.edge").first().getAttribute("d")) !== edgeBefore);
    await page.mouse.up();
    await page.waitForTimeout(1200);
    const last = (await seen()).at(-1) || {};
    check("drag: edit sends flat and wrapped revision", typeof last.revision === "string" && last.requestBody?.revision === last.revision);
    check("drag: saved with no error shown", await app.locator("#notice").isHidden(), await app.locator("#notice").textContent());
    const trig = (await draft()).nodes.find((n) => n.id === "trigger");
    check("drag: new position stored", trig.position.y > 250, JSON.stringify(trig.position));

    // Claude edits in between: the canvas's stale move is refused and explained in one sentence.
    await claudeEdits([{ op: "move_node", id: "email_cold", position: { x: 650, y: 420 } }]);
    const b2 = await app.locator('g.node[aria-label^="Route by lead_score"]').boundingBox();
    await page.mouse.move(b2.x + 30, b2.y + 15); await page.mouse.down();
    await page.mouse.move(b2.x + 30, b2.y + 95, { steps: 5 }); await page.mouse.up();
    await page.waitForTimeout(1200);
    const msg = (await app.locator("#notice").textContent()) || "";
    check("conflict: stale edit refused with a plain sentence", !msg.includes("{") && msg.includes("changed since you read it"), msg);

    // Rename and change settings from the panel.
    await pick("Email (cold)");
    await app.locator("#n-label").fill("Email: cold nurture");
    const cfg = JSON.parse(await app.locator("#n-config").inputValue());
    cfg.subject = "More about OmniDimension";
    await app.locator("#n-config").fill(JSON.stringify(cfg, null, 2));
    await app.locator("#save").click();
    await page.waitForTimeout(1200);
    check("edit: renamed node shows on the canvas", (await app.locator('g.node[aria-label^="Email: cold nurture"]').count()) === 1);
    const cold = (await draft()).nodes.find((n) => n.id === "email_cold");
    check("edit: settings change stored", cold.config.subject === "More about OmniDimension");
    check("edit: an old failure message clears after a save works", await app.locator("#notice").isHidden(), await app.locator("#notice").textContent());

    // Invalid JSON in settings is caught before sending.
    await app.locator("#n-config").fill("{ not json");
    const before = (await seen()).length;
    await app.locator("#save").click();
    await page.waitForTimeout(300);
    check("edit: bad JSON is refused before saving", (await seen()).length === before && ((await app.locator("#notice").textContent()) || "").includes("not valid JSON"));

    // Delete needs two clicks; the node and its arrows go away.
    await pick("Wait 30 min");
    const edgesBefore = await app.locator("path.edge").count();
    await app.locator("#delete").click();
    await page.waitForTimeout(200);
    check("delete: first click only asks to confirm", (await app.locator('g.node[aria-label^="Wait 30 min"]').count()) === 1);
    await app.locator("#delete").click();
    await page.waitForTimeout(1200);
    check("delete: node removed", (await app.locator('g.node[aria-label^="Wait 30 min"]').count()) === 0);
    check("delete: its arrows removed", (await app.locator("path.edge").count()) === edgesBefore - 2);
    check("session: no page errors", errors.length === 0, errors.join(" | "));
    await page.close();

    {
        const d = await openCanvas(browser, base, { theme: "dark" });
        await d.app.locator("g.node").first().waitFor({ timeout: 10000 });
        await d.page.waitForTimeout(600);
        check("dark: renders with no errors", d.errors.length === 0, d.errors.join(" | "));
        await d.page.close();
    }
}
