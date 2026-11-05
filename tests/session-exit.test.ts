import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const BINARY = resolve(__dirname, "..", "build", "index.js");
const PRELOAD = resolve(__dirname, "fixtures", "capture-fetch.mjs");

function runSession(end: (child: ReturnType<typeof spawn>) => void): Promise<string[]> {
    const dir = mkdtempSync(join(tmpdir(), "omnidim-exit-"));
    const capture = join(dir, "events.jsonl");
    return new Promise((done, fail) => {
        const child = spawn("node", ["--import", PRELOAD, BINARY], {
            env: { ...process.env, HOME: dir, USERPROFILE: dir, CAPTURE_FILE: capture, OMNIDIM_API_KEY: "sk_test", OMNIDIM_TELEMETRY: "on", DO_NOT_TRACK: "" },
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
        setTimeout(() => end(child), 1500);
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
});
