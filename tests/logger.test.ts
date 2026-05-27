import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let appendLog: (f: { kind: "tool_error" | "setup" | "crash"; [k: string]: unknown }) => void;
let readLogTail: (n?: number) => string[];
let scrubSecrets: (s: string) => string;

beforeEach(async () => {
    // Stub both so os.homedir() redirects on POSIX (HOME) and Windows (USERPROFILE).
    const tmp = mkdtempSync(`${tmpdir()}/omni-log-`);
    vi.stubEnv("HOME", tmp);
    vi.stubEnv("USERPROFILE", tmp);
    vi.resetModules();
    const mod = await import("../src/logger.js");
    appendLog = mod.appendLog;
    readLogTail = mod.readLogTail;
    scrubSecrets = mod.scrubSecrets;
});
afterEach(() => vi.unstubAllEnvs());

describe("scrubSecrets", () => {
    it("redacts sk_ keys, bearer tokens, and key/token fields", () => {
        expect(scrubSecrets("key sk_live_abcdef123456 here")).toContain("sk_[redacted]");
        expect(scrubSecrets("Authorization: Bearer abcdef1234567890")).toMatch(/\[redacted\]/i);
        expect(scrubSecrets('"api_key":"abcdef12345678"')).toContain("[redacted]");
    });

    it("leaves ordinary diagnostic text untouched", () => {
        expect(scrubSecrets("config_invalid_json on vscode")).toBe("config_invalid_json on vscode");
    });
});

describe("appendLog + readLogTail", () => {
    it("returns an empty tail when nothing has been logged", () => {
        expect(readLogTail()).toEqual([]);
    });

    it("writes a scrubbed JSON line and reads it back", () => {
        appendLog({ kind: "tool_error", tool: "listAgents", code: "http_500", message: "boom sk_live_secret123456" });
        const tail = readLogTail();
        expect(tail).toHaveLength(1);
        expect(tail[0]).toContain('"tool":"listAgents"');
        expect(tail[0]).toContain("sk_[redacted]");
        expect(tail[0]).not.toContain("secret123456");
    });
});
