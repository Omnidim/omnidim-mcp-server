// Browser tests for the workflow canvas in a test chat host: `npm run test:canvas [general|move|security]`.
// Uses the installed Chrome. No API key, no network: the canvas talks to the fake API in server.mjs.
import { chromium } from "playwright-core";

import general from "./general.mjs";
import move from "./move.mjs";
import security from "./security.mjs";
import { startServer } from "./server.mjs";

const only = process.argv[2];
const server = await startServer();
const browser = await chromium.launch({ channel: "chrome", headless: true });
const results = [];
try {
    for (const [name, suite] of Object.entries({ general, move, security })) {
        if (only && only !== name) continue;
        await fetch(server.url + "/reset");
        const check = (label, ok, detail = "") => results.push(`${ok ? "PASS" : "FAIL"}  ${name}: ${label}${!ok && detail ? `  (${detail})` : ""}`);
        await suite({ browser, base: server.url, check });
    }
} finally {
    await browser.close();
    server.close();
}
const failed = results.filter((r) => r.startsWith("FAIL")).length;
console.log(results.join("\n"));
console.log(`${results.length - failed}/${results.length} passed`);
process.exitCode = failed ? 1 : 0;
