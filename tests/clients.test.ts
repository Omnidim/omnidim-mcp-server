import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { buildTargets, describeInstallError, type HostEnv } from "../src/clients.js";

let home: string;

beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "omni-clients-"));
});
afterEach(() => {
    rmSync(home, { recursive: true, force: true });
});

// A fake host rooted at the temp home so no real machine path is touched.
function host(platform: NodeJS.Platform): HostEnv {
    return {
        platform,
        home,
        appData: join(home, "AppData", "Roaming"),
        xdgConfig: join(home, ".config"),
    };
}

function target(env: HostEnv, id: string) {
    const t = buildTargets(env).find((x) => x.id === id);
    if (!t) throw new Error(`no target ${id}`);
    return t;
}

function readJson(path: string): Record<string, any> {
    return JSON.parse(readFileSync(path, "utf8"));
}

describe("describeInstallError", () => {
    it("reduces a filesystem error to errno + class, never the path", () => {
        const e = Object.assign(
            new Error("EACCES: permission denied, open '/Users/alice/.cursor/mcp.json'"),
            { code: "EACCES" },
        );
        expect(describeInstallError(e)).toEqual({ error_class: "Error", error_code: "EACCES" });
    });
});

describe("per-OS config paths", () => {
    it("macOS Claude Desktop writes to Library/Application Support", () => {
        const env = host("darwin");
        mkdirSync(join(home, "Library", "Application Support", "Claude"), { recursive: true });
        const t = target(env, "claude_desktop");
        expect(t.detect()).toBe(true);
        t.install("sk_test");
        const cfg = readJson(join(home, "Library", "Application Support", "Claude", "claude_desktop_config.json"));
        expect(cfg.mcpServers.omnidim.command).toBe("npx");
    });

    it("Windows resolves Claude Desktop and VS Code under %APPDATA%", () => {
        const env = host("win32");
        const t = target(env, "vscode");
        t.install("sk_test");
        expect(existsSync(join(home, "AppData", "Roaming", "Code", "User", "mcp.json"))).toBe(true);
        // Claude Desktop target exists on Windows and points under %APPDATA%.
        const cd = target(env, "claude_desktop");
        cd.install("sk_test");
        expect(existsSync(join(home, "AppData", "Roaming", "Claude", "claude_desktop_config.json"))).toBe(true);
    });

    it("Linux has no Claude Desktop target and uses XDG for VS Code", () => {
        const env = host("linux");
        expect(buildTargets(env).find((t) => t.id === "claude_desktop")).toBeUndefined();
        target(env, "vscode").install("sk_test");
        expect(existsSync(join(home, ".config", "Code", "User", "mcp.json"))).toBe(true);
    });
});

describe("schema per client", () => {
    it("VS Code writes under `servers` with an explicit stdio type", () => {
        const env = host("darwin");
        target(env, "vscode").install("sk_test");
        const cfg = readJson(join(home, "Library", "Application Support", "Code", "User", "mcp.json"));
        expect(cfg.servers.omnidim.type).toBe("stdio");
        expect(cfg.mcpServers).toBeUndefined();
    });

    it("Cursor writes under `mcpServers`", () => {
        const env = host("darwin");
        target(env, "cursor").install("sk_test");
        const cfg = readJson(join(home, ".cursor", "mcp.json"));
        expect(cfg.mcpServers.omnidim.env.OMNIDIM_API_KEY).toBe("sk_test");
    });
});

describe("create-if-missing and merge", () => {
    it("creates the config file and parent dirs when absent", () => {
        const env = host("darwin");
        const path = join(home, ".cursor", "mcp.json");
        expect(existsSync(path)).toBe(false);
        target(env, "cursor").install("sk_test");
        expect(existsSync(path)).toBe(true);
    });

    it("preserves existing servers when merging", () => {
        const env = host("darwin");
        const path = join(home, ".cursor", "mcp.json");
        mkdirSync(join(home, ".cursor"), { recursive: true });
        writeFileSync(path, JSON.stringify({ mcpServers: { other: { command: "x" } } }));
        target(env, "cursor").install("sk_test");
        const cfg = readJson(path);
        expect(cfg.mcpServers.other.command).toBe("x");
        expect(cfg.mcpServers.omnidim.command).toBe("npx");
    });

    it("treats an empty/whitespace config file as fresh and still installs", () => {
        const env = host("darwin");
        const path = join(home, ".cursor", "mcp.json");
        mkdirSync(join(home, ".cursor"), { recursive: true });
        writeFileSync(path, "  \n"); // the "Unexpected end of JSON input" case
        target(env, "cursor").install("sk_test");
        expect(readJson(path).mcpServers.omnidim.command).toBe("npx");
    });

    it("reports genuinely malformed JSON as config_invalid_json", () => {
        const env = host("darwin");
        const path = join(home, ".cursor", "mcp.json");
        mkdirSync(join(home, ".cursor"), { recursive: true });
        writeFileSync(path, "{ not valid json");
        try {
            target(env, "cursor").install("sk_test");
            throw new Error("expected install to throw");
        } catch (e) {
            expect(describeInstallError(e)).toMatchObject({ error_code: "config_invalid_json" });
        }
    });
});

describe("detection keys off the app, not the config file", () => {
    it("detects Claude Code from its config in the home dir", () => {
        const env = host("darwin");
        writeFileSync(join(home, ".claude.json"), "{}");
        expect(target(env, "claude_code").detect()).toBe(true);
    });

    it("does not detect Cursor when its dir is absent", () => {
        expect(target(host("darwin"), "cursor").detect()).toBe(false);
    });
});
