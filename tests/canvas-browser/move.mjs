// Move and save edge cases. Each case starts from a fresh page and the fixture workflow.
import { api, openCanvas } from "./harness.mjs";

export default async function move({ browser, base, check }) {
    const { ctl, seen, draft, posOf, claudeEdits } = api(base);
    const errorLists = [];

    async function fresh(viewport) {
        await ctl("/reset");
        const t = await openCanvas(browser, base, { viewport });
        errorLists.push(t.errors);
        await t.app.locator("g.node").first().waitFor({ timeout: 10000 });
        await t.page.waitForTimeout(500);
        const scale = async () => {
            const svg = t.app.locator("#canvas");
            return Number(await svg.getAttribute("width")) / Number((await svg.getAttribute("viewBox")).split(" ")[2]);
        };
        // Drags by screen pixels and returns once the pointer is released; the save may still be running.
        const drag = async (label, dx, dy) => {
            const b = await t.node(label).boundingBox();
            const x = b.x + 40, y = b.y + 18;
            await t.page.mouse.move(x, y); await t.page.mouse.down();
            await t.page.mouse.move(x + dx, y + dy, { steps: 8 });
            await t.page.mouse.up();
        };
        const settle = () => t.page.waitForTimeout(1200);
        return { ...t, scale, drag, settle };
    }
    const typeConfig = async (t, change) => {
        await t.pick("Email (cold)");
        const cfg = JSON.parse(await t.app.locator("#n-config").inputValue()); change(cfg);
        await t.app.locator("#n-config").fill(JSON.stringify(cfg, null, 2));
    };
    const noticeText = (t) => t.app.locator("#notice").evaluate((el) => el.hidden ? "" : el.textContent);

    // M0: a validation answer that lands mid-drag must not cancel the drag.
    {
        await ctl("/reset"); await ctl("/slow-validate?ms=1200");
        const t = await openCanvas(browser, base);
        errorLists.push(t.errors);
        await t.app.locator("g.node").first().waitFor({ timeout: 10000 });
        await t.page.waitForTimeout(300);
        const b = await t.node("Email (cold)").boundingBox();
        await t.page.mouse.move(b.x + 40, b.y + 18); await t.page.mouse.down();
        await t.page.mouse.move(b.x + 120, b.y + 18, { steps: 4 });
        await t.page.waitForTimeout(1200);
        await t.page.mouse.move(b.x + 140, b.y + 18, { steps: 2 }); await t.page.mouse.up();
        await t.page.waitForTimeout(1200);
        check("M0 drag survives a validation answer that lands mid-drag", (await posOf("email_cold")).x > 650);
        check("M0 problem marks still appear after the drop", await t.app.locator("g.node.invalid").first().waitFor({ timeout: 3000 }).then(() => true, () => false));
        await t.page.close();
    }

    // M1: a click with a tiny wobble selects, sends nothing.
    { const t = await fresh(); const n0 = (await seen()).length;
        await t.drag("Email (cold)", 2, 1); await t.settle();
        check("M1 click with a 2px wobble selects the node and sends no edit", (await seen()).length === n0 && await t.app.locator("#panel").isVisible());
        await t.page.close(); }

    // M2: drag away and back to the start: no edit.
    { const t = await fresh(); const n0 = (await seen()).length;
        const b = await t.node("Email (cold)").boundingBox();
        await t.page.mouse.move(b.x + 40, b.y + 18); await t.page.mouse.down();
        await t.page.mouse.move(b.x + 140, b.y + 80, { steps: 6 }); await t.page.mouse.move(b.x + 40, b.y + 18, { steps: 6 }); await t.page.mouse.up();
        await t.settle();
        check("M2 drag away and back to the start sends no edit", (await seen()).length === n0);
        await t.page.close(); }

    // M3: stored delta matches the screen move at the current zoom, in whole numbers.
    { const t = await fresh(); const before = await posOf("email_cold"); const s = await t.scale();
        await t.drag("Email (cold)", 100, 50); await t.settle();
        const after = await posOf("email_cold");
        const dx = after.x - before.x, dy = after.y - before.y;
        check("M3 stored move matches the screen move at this zoom", Math.abs(dx - 100 / s) <= 1.5 && Math.abs(dy - 50 / s) <= 1.5, `dx=${dx} dy=${dy} expected ${(100 / s).toFixed(1)},${(50 / s).toFixed(1)}`);
        check("M3 positions are whole numbers", Number.isInteger(after.x) && Number.isInteger(after.y), JSON.stringify(after));
        await t.page.close(); }

    // M4: three moves in a row each save with the latest revision.
    { const t = await fresh(); const n0 = (await seen()).length;
        await t.drag("Email (cold)", 60, 0); await t.settle();
        await t.drag("Webhook In", 0, 60); await t.settle();
        await t.drag("Email (cold)", 0, 40); await t.settle();
        const edits = (await seen()).slice(n0);
        const revs = edits.map((e) => e.revision);
        check("M4 three moves in a row all save", edits.length === 3 && await t.app.locator("#notice").isHidden(), `edits=${edits.length} notice=${await t.app.locator("#notice").textContent()}`);
        check("M4 each move uses a new revision", new Set(revs).size === 3, revs.join(","));
        await t.page.close(); }

    // M5: a drag while a save is still running is ignored, and the first save lands.
    { const t = await fresh(); await ctl("/slow-edit?ms=2000");
        const startTrig = await posOf("trigger");
        await t.drag("Email (cold)", 80, 0);
        await t.page.waitForTimeout(300);
        const box1 = await t.node("Webhook In").boundingBox();
        await t.drag("Webhook In", 0, 80);
        const box2 = await t.node("Webhook In").boundingBox();
        await t.page.waitForTimeout(2600);
        check("M5 second drag during a running save does not move the node", Math.abs(box1.y - box2.y) < 2, `${box1.y} -> ${box2.y}`);
        check("M5 the first save still lands", (await posOf("email_cold")).x !== 650 && JSON.stringify(await posOf("trigger")) === JSON.stringify(startTrig));
        await t.page.close(); }

    // M6: a failed save puts the node back, says so plainly, and the next move works and clears it.
    { const t = await fresh(); await ctl("/fail-next");
        const b0 = await t.node("Email (cold)").boundingBox();
        await t.drag("Email (cold)", 120, 0); await t.settle();
        const b1 = await t.node("Email (cold)").boundingBox();
        const msg = (await t.app.locator("#notice").textContent()) || "";
        check("M6 failed save puts the node back", Math.abs(b1.x - b0.x) < 2, `${b0.x} -> ${b1.x}`);
        check("M6 failure is one plain sentence", msg.startsWith("Not saved:") && !msg.includes("{"), msg);
        await t.drag("Email (cold)", 120, 0); await t.settle();
        check("M6 next move saves and clears the message", (await posOf("email_cold")).x > 650 && await t.app.locator("#notice").isHidden());
        await t.page.close(); }

    // M7: Claude moved something after the canvas loaded: refused, rolled back, reloaded with Claude's change, retry works.
    { const t = await fresh();
        await claudeEdits([{ op: "move_node", id: "wa_warm", position: { x: 650, y: 300 } }]);
        const b0 = await t.node("Webhook In").boundingBox();
        await t.drag("Webhook In", 0, 90); await t.settle();
        const msg = (await t.app.locator("#notice").textContent()) || "";
        const b1 = await t.node("Webhook In").boundingBox();
        check("M7 stale move refused with a plain sentence", msg.includes("changed since you read it"), msg);
        check("M7 the user's node goes back", Math.abs(b1.y - b0.y) < 2);
        const waBox = await t.node("WhatsApp (warm)").boundingBox(), s = await t.scale();
        check("M7 canvas reloads and shows Claude's change", waBox && (await posOf("wa_warm")).y === 300 && Math.abs(waBox.y - (b0.y + (300 - 200) * s)) < 4, `y=${waBox && waBox.y}`);
        await t.drag("Webhook In", 0, 90); await t.settle();
        check("M7 retry after the reload saves", (await posOf("trigger")).y > 200 && await t.app.locator("#notice").isHidden());
        await t.page.close(); }

    // M8: dragging past the top-left edge stores negative positions and the node stays on the canvas.
    { const t = await fresh();
        const s8 = await t.scale(); await t.drag("Webhook In", -20, -Math.round(250 * s8)); await t.settle();
        const p = await posOf("trigger");
        const box = await t.node("Webhook In").boundingBox(), svgBox = await t.app.locator("#canvas").boundingBox();
        check("M8 negative position stored", p.y < 0, JSON.stringify(p));
        check("M8 node still inside the canvas after reload", box.y >= svgBox.y - 1 && box.x >= svgBox.x - 1);
        await t.page.close(); }

    // M9: the release happens outside the chat frame, so the frame never sees it. The next event the browser
    // sends when the pointer comes back is a move with no button held: that must end the drag and save it.
    { const t = await fresh();
        const b = await t.node("Email (cold)").boundingBox();
        await t.page.mouse.move(b.x + 40, b.y + 18); await t.page.mouse.down();
        await t.page.mouse.move(b.x + 140, b.y + 18, { steps: 6 });
        const f = t.page.frames().find((x) => x !== t.page.mainFrame());
        await f.evaluate(() => document.dispatchEvent(new PointerEvent("pointermove", { bubbles: true, buttons: 0, clientX: 5, clientY: 5 })));
        await t.settle();
        check("M9 return with no button held ends the drag and saves", (await posOf("email_cold")).x > 650 && (await t.app.locator("g.node.dragging").count()) === 0);
        await f.evaluate(() => document.dispatchEvent(new PointerEvent("pointermove", { bubbles: true, buttons: 0, clientX: 400, clientY: 300 })));
        const b9 = await t.node("Email (cold)").boundingBox(); await t.page.waitForTimeout(150);
        const b9b = await t.node("Email (cold)").boundingBox();
        check("M9 node does not follow the cursor afterwards", Math.abs(b9b.x - b9.x) < 2);
        await t.page.mouse.up(); await t.page.close(); }

    // M10: in full screen the zoom changes, and the stored move still matches the screen move.
    { const t = await fresh();
        await t.app.locator("#full").click(); await t.page.waitForTimeout(500);
        const s = await t.scale(), before = await posOf("email_cold");
        await t.drag("Email (cold)", 90, 0); await t.settle();
        const dx = (await posOf("email_cold")).x - before.x;
        check("M10 move in full screen matches the screen move", Math.abs(dx - 90 / s) <= 1.5, `dx=${dx} expected ${(90 / s).toFixed(1)}`);
        await t.page.close(); }

    // M11: typed but unsaved settings survive a move of another node, then save.
    { const t = await fresh();
        await t.pick("Email (cold)");
        const cfg = JSON.parse(await t.app.locator("#n-config").inputValue()); cfg.subject = "Typed but not saved";
        await t.app.locator("#n-config").fill(JSON.stringify(cfg, null, 2));
        await t.drag("Webhook In", 0, 60); await t.settle();
        const kept = (await t.app.locator("#n-config").inputValue()).includes("Typed but not saved");
        check("M11 unsaved settings survive a move of another node", kept);
        await t.app.locator("#save").click(); await t.settle();
        const cold = (await draft()).nodes.find((n) => n.id === "email_cold");
        check("M11 then they save", cold.config.subject === "Typed but not saved");
        await t.page.close(); }

    // M12: removing a key sends null for it; unchanged keys are not sent.
    { const t = await fresh(); const n0 = (await seen()).length;
        await t.pick("Email (cold)");
        const cfg = JSON.parse(await t.app.locator("#n-config").inputValue()); delete cfg.body_type;
        await t.app.locator("#n-config").fill(JSON.stringify(cfg, null, 2));
        await t.app.locator("#save").click(); await t.settle();
        const op = (await seen())[n0]?.ops?.[0] || {};
        check("M12 removed key is sent as null and removed", op.config && op.config.body_type === null && !("body_type" in (await draft()).nodes.find((n) => n.id === "email_cold").config), JSON.stringify(op));
        check("M12 unchanged keys are not sent", op.config && !("subject" in op.config) && !("email_to" in op.config));
        await t.page.close(); }

    // M13: arrows in and out of a dragged node follow it, and match the stored spot after the save.
    { const t = await fresh();
        const paths = async () => t.app.locator("path.edge").evaluateAll((els) => els.map((e) => e.getAttribute("d")));
        const p0 = await paths();
        const b = await t.node("Route by lead_score").boundingBox();
        await t.page.mouse.move(b.x + 40, b.y + 18); await t.page.mouse.down();
        await t.page.mouse.move(b.x + 40, b.y + 118, { steps: 8 });
        const p1 = await paths();
        await t.page.mouse.up(); await t.settle();
        const changed = p0.filter((d, i) => d !== p1[i]).length;
        check("M13 incoming and outgoing arrows follow during the drag", changed === 4, `changed=${changed}`);
        const p2 = await paths();
        check("M13 arrows after the save match where the node was dropped", JSON.stringify(p1) === JSON.stringify(p2));
        await t.page.close(); }

    // M14: the save button shows progress and is disabled while saving.
    { const t = await fresh(); await ctl("/slow-edit?ms=1500");
        await t.pick("Email (cold)");
        await t.app.locator("#n-label").fill("Email cold v2");
        await t.app.locator("#save").click(); await t.page.waitForTimeout(300);
        const during = { text: await t.app.locator("#save").textContent(), disabled: await t.app.locator("#save").isDisabled() };
        await t.page.waitForTimeout(1800);
        check("M14 save button shows Saving and is disabled while saving", during.text === "Saving…" && during.disabled, JSON.stringify(during));
        check("M14 button comes back after the save", (await t.app.locator("#save").textContent()) === "Save changes" && !(await t.app.locator("#save").isDisabled()));
        await t.page.close(); }

    // M15: Claude changed the same field while the user typed: refused, Claude's value kept, nothing sent.
    { const t = await fresh();
        await typeConfig(t, (c) => { c.subject = "User subject"; });
        await claudeEdits([{ op: "update_node", id: "email_cold", config: { subject: "Claude subject" } }]);
        await t.app.locator("#refresh").click(); await t.settle();
        const n0 = (await seen()).length;
        await t.app.locator("#save").click(); await t.settle();
        check("M15 same-field clash is refused with a plain notice", (await noticeText(t)).startsWith("Claude changed subject"), await noticeText(t));
        check("M15 Claude's value is kept and no edit is sent", (await seen()).length === n0 && (await draft()).nodes.find((n) => n.id === "email_cold").config.subject === "Claude subject");
        await t.page.close(); }

    // M16: Claude changed a different field: the user's save sends only its own key, both survive.
    { const t = await fresh();
        await typeConfig(t, (c) => { c.subject = "User subject"; });
        await claudeEdits([{ op: "update_node", id: "email_cold", config: { email_to: "claude@example.com" } }]);
        await t.app.locator("#refresh").click(); await t.settle();
        const n0 = (await seen()).length;
        await t.app.locator("#save").click(); await t.settle();
        const cfg = (await draft()).nodes.find((n) => n.id === "email_cold").config;
        const sent = (await seen())[n0]?.ops?.[0]?.config || {};
        check("M16 a change to another field merges: both edits survive", cfg.subject === "User subject" && cfg.email_to === "claude@example.com", JSON.stringify(cfg));
        check("M16 only the user's key is sent", JSON.stringify(Object.keys(sent)) === '["subject"]', JSON.stringify(sent));
        await t.page.close(); }

    // M17: settings that parse but are not an object are refused before any request.
    for (const bad of ["[1, 2]", "null", "\"text\"", "42"]) {
        const t = await fresh(); const n0 = (await seen()).length;
        await t.pick("Email (cold)");
        await t.app.locator("#n-config").fill(bad);
        await t.app.locator("#save").click(); await t.settle();
        check(`M17 settings ${bad} are refused with no edit`, (await seen()).length === n0 && (await noticeText(t)).startsWith("The settings must be a JSON object"), await noticeText(t));
        await t.page.close(); }

    // M18: a second finger (non-primary pointer) never starts a drag or a save.
    { const t = await fresh(); const n0 = (await seen()).length; const p0 = await posOf("email_cold");
        await t.node("Email (cold)").evaluate((g) => {
            const o = { bubbles: true, button: 0, buttons: 1, clientX: 100, clientY: 100, pointerId: 7, isPrimary: false };
            g.dispatchEvent(new PointerEvent("pointerdown", o));
            document.dispatchEvent(new PointerEvent("pointermove", { ...o, clientX: 300, clientY: 300 }));
            document.dispatchEvent(new PointerEvent("pointerup", { ...o, buttons: 0, clientX: 300, clientY: 300 }));
        });
        await t.settle();
        check("M18 a non-primary pointer moves nothing and sends nothing", (await seen()).length === n0 && JSON.stringify(await posOf("email_cold")) === JSON.stringify(p0));
        await t.page.close(); }

    // M19: a drop that lands while the workflow is reloading snaps back, says so, and sends nothing.
    { const t = await fresh(); const n0 = (await seen()).length; const p0 = await posOf("email_cold");
        const b = await t.node("Email (cold)").boundingBox();
        await t.page.mouse.move(b.x + 40, b.y + 18); await t.page.mouse.down();
        await t.page.mouse.move(b.x + 140, b.y + 18, { steps: 6 });
        await ctl("/slow-get?ms=1500");
        await t.app.locator("body").evaluate(() => { refresh(); });
        await t.page.waitForTimeout(200);
        await t.page.mouse.up(); await t.page.waitForTimeout(200);
        const said = await noticeText(t);
        const back = await t.node("Email (cold)").boundingBox();
        await t.page.waitForTimeout(1800);
        check("M19 drop during a reload says to try again", said === "Still loading the workflow. Try again in a moment.", said);
        check("M19 the node snaps back and nothing is sent", Math.abs(back.x - b.x) < 2 && (await seen()).length === n0 && JSON.stringify(await posOf("email_cold")) === JSON.stringify(p0));
        await t.page.close(); }

    const pageErrors = errorLists.flat();
    check("no page errors in any case", pageErrors.length === 0, pageErrors.slice(0, 3).join(" | "));
}
