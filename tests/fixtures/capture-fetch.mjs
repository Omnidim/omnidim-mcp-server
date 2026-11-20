// Preload for child-process tests: records telemetry bodies to CAPTURE_FILE instead of sending them.
// FETCH_DELAY_MS makes each send slow, so a process that exits too early loses the event.
import { appendFileSync } from "node:fs";
const delay = Number(process.env.FETCH_DELAY_MS ?? 0);
globalThis.fetch = async (_url, init) => {
    if (delay) await new Promise((r) => setTimeout(r, delay));
    appendFileSync(process.env.CAPTURE_FILE, init.body + "\n");
    return new Response(null, { status: 204 });
};
