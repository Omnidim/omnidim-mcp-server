// Preload for child-process tests: records telemetry bodies to CAPTURE_FILE instead of sending them.
import { appendFileSync } from "node:fs";
globalThis.fetch = async (_url, init) => {
    appendFileSync(process.env.CAPTURE_FILE, init.body + "\n");
    return new Response(null, { status: 204 });
};
