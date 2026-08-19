/**
 * Update notifier. This server is run by an MCP client via `npx`, so it cannot
 * relaunch itself; an unpinned `npx` install already picks up the newest
 * published version the next time the client restarts the server. This module
 * just makes that visible: a one-line notice (stderr only, never stdout, which
 * is the JSON-RPC channel) when the running version changed since last time, or
 * when a newer version exists on npm. Everything here is best-effort and
 * fail-silent: a notice must never delay startup or crash the server.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const PACKAGE = "@omnidim-ai/mcp-server";
const RELEASES = "https://github.com/Omnidim/omnidim-mcp-server/releases";
const CONFIG_DIR = join(homedir(), ".config", "omnidim");
const LAST_VERSION_FILE = join(CONFIG_DIR, "last-version");
const LAST_CHECK_FILE = join(CONFIG_DIR, "last-update-check");
const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000; // throttle the npm check to once a day
const FETCH_TIMEOUT_MS = 2500;

export function releaseTagUrl(version: string): string {
    return `${RELEASES}/tag/v${version}`;
}

/** True when `a` is a strictly newer semver than `b` (pre-release suffix ignored). */
export function isNewer(a: string, b: string): boolean {
    const parse = (v: string) => v.split("-")[0].split(".").map((n) => parseInt(n, 10) || 0);
    const [a1, a2, a3] = parse(a);
    const [b1, b2, b3] = parse(b);
    if (a1 !== b1) return a1 > b1;
    if (a2 !== b2) return a2 > b2;
    return a3 > b3;
}

export function updatedNotice(version: string): string {
    return `${PACKAGE} updated to v${version}. What's new: ${releaseTagUrl(version)}`;
}

export function availableNotice(current: string, latest: string): string {
    return `A newer ${PACKAGE} is available: v${latest} (you have v${current}). `
        + `Release notes: ${releaseTagUrl(latest)}. It updates automatically the next time your MCP client restarts.`;
}

function readFileSafe(path: string): string | null {
    try { return readFileSync(path, "utf8").trim() || null; } catch { return null; }
}
function writeFileSafe(path: string, value: string): void {
    try { mkdirSync(CONFIG_DIR, { recursive: true }); writeFileSync(path, value); } catch { /* best-effort */ }
}

/** Print "just updated to vX" when the stored version differs from the running one. */
function notifyVersionChanged(current: string): void {
    const stored = readFileSafe(LAST_VERSION_FILE);
    if (stored && stored !== current && isNewer(current, stored)) {
        console.error(updatedNotice(current));
    }
    if (stored !== current) writeFileSafe(LAST_VERSION_FILE, current);
}

/** Best-effort npm check (throttled, timeout-bounded, opt-out via env). */
async function notifyNewerAvailable(current: string): Promise<void> {
    if (process.env.OMNIDIM_NO_UPDATE_CHECK) return;
    if (typeof fetch !== "function") return;
    const last = readFileSafe(LAST_CHECK_FILE);
    if (last && Date.now() - Number(last) < CHECK_INTERVAL_MS) return;
    writeFileSafe(LAST_CHECK_FILE, String(Date.now()));
    try {
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
        const res = await fetch(`https://registry.npmjs.org/${PACKAGE}/latest`, { signal: ctrl.signal });
        clearTimeout(timer);
        if (!res.ok) return;
        const latest = (await res.json())?.version;
        if (typeof latest === "string" && isNewer(latest, current)) {
            console.error(availableNotice(current, latest));
        }
    } catch { /* offline / timeout / parse error: stay silent */ }
}

/** Fire-and-forget. Synchronous local notice, async npm check that never blocks. */
export function notifyUpdates(currentVersion: string): void {
    try { notifyVersionChanged(currentVersion); } catch { /* never block startup */ }
    void notifyNewerAvailable(currentVersion);
}
