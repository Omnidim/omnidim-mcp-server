import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const BINARY = resolve(__dirname, "..", "build", "index.js");
const PRELOAD = resolve(__dirname, "fixtures", "capture-fetch.mjs");

function runSession(
    end: (child: ReturnType<typeof spawn>) => void,
    { args = [] as string[], fetchDelayMs = 0, endAfterMs = 1500 } = {},
): Promise<string[]> {
    const dir = mkdtempSync(join(tmpdir(), "omnidim-exit-"));
    const capture = join(dir, "events.jsonl");
    return new Promise((done, fail) => {
        const child = spawn("node", ["--import", PRELOAD, BINARY, ...args], {
            env: { ...process.env, HOME: dir, USERPROFILE: dir, CAPTURE_FILE: capture, OMNIDIM_API_KEY: "sk_test", OMNIDIM_TELEMETRY: "on", DO_NOT_TRACK: "", FETCH_DELAY_MS: String(fetchDelayMs) },
            stdio: ["pipe", "ignore", "ignore"],
        });
        child.on("error", fail);
        const timer = setTimeout(() => { child.kill("SIGKILL"); fail(new Error("server did not exit")); }, 8000);
        child.on("exit", () => {
            clearTimeout(timer);
            let text = "";
            try { text = readFileSync(capture, "utf8"); } catch { /* nothing sent */ }
            rmSync(dir, { recursive: true, force: true });
            done(text.split("\n").filter((l) => l.startsWith("{")).map((l) => JSON.parse(l).event));
        });
        setTimeout(() => end(child), endAfterMs);
    });
}

describe("session_end on exit", () => {
    it("is sent when the client closes stdin", async () => {
        const events = await runSession((c) => c.stdin!.end());
        expect(events).toContain("session_start");
        expect(events).toContain("session_end");
    }, 15000);

    it("is sent on SIGTERM and SIGHUP", async () => {
        expect(await runSession((c) => c.kill("SIGTERM"))).toContain("session_end");
        expect(await runSession((c) => c.kill("SIGHUP"))).toContain("session_end");
    }, 25000);

    it("survives a SIGTERM while the stdin-close send is still in flight", async () => {
        const events = await runSession((c) => {
            c.stdin!.end();
            setTimeout(() => c.kill("SIGTERM"), 100);
        }, { fetchDelayMs: 800 });
        expect(events).toContain("session_end");
    }, 15000);
});

describe("setup exit", () => {
    // setup's key check calls the real API through axios, so this guards the generated file instead of spawning it.
    it("waits for setup telemetry before exiting", () => {
        const src = readFileSync(resolve(__dirname, "..", "src", "index.ts"), "utf8");
        const branch = src.slice(src.indexOf('process.argv[2] === "setup"'), src.indexOf('process.argv[2] === "telemetry"'));
        expect(branch.indexOf("await flushTelemetry()")).toBeGreaterThan(-1);
        expect(branch.indexOf("await flushTelemetry()")).toBeLessThan(branch.indexOf("process.exit(code)"));
    });
});
