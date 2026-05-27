import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import { sanitizeError, type SanitizedError } from "./telemetry.js";

const PKG = "@omnidim-ai/mcp-server";
const NPX_ARGS = ["-y", PKG];

// The host paths targets are resolved against. Injected (rather than read
// from the process at import time) so tests can simulate any OS and a clean
// machine without touching the real one.
export interface HostEnv {
    platform: NodeJS.Platform;
    home: string;
    appData: string; // Windows %APPDATA%
    xdgConfig: string; // Linux ~/.config
}

export function currentHostEnv(): HostEnv {
    const home = homedir();
    return {
        platform: process.platform,
        home,
        appData: process.env.APPDATA || join(home, "AppData", "Roaming"),
        xdgConfig: process.env.XDG_CONFIG_HOME || join(home, ".config"),
    };
}

export interface ClientTarget {
    name: string;
    id: string;
    // App is considered installed when this returns true. Keyed off the
    // app's own directory/binary, not its MCP config file: a fresh install
    // has the app but no config file yet, and we create the file ourselves.
    detect: () => boolean;
    install: (apiKey: string) => void;
}

// Carries a sanitized failure category so the setup funnel can report why a
// client install failed without shipping the raw message (which holds paths).
class ClientInstallError extends Error {
    readonly errorCode: string;
    readonly errorClass: string;
    readonly exitCode?: number;
    constructor(message: string, errorCode: string, errorClass: string, exitCode?: number) {
        super(message);
        this.name = "ClientInstallError";
        this.errorCode = errorCode;
        this.errorClass = errorClass;
        this.exitCode = exitCode;
    }
}

// Reduce a caught install error to the sanitized fields the funnel reports.
export function describeInstallError(e: unknown): SanitizedError & { exit_code?: number } {
    if (e instanceof ClientInstallError) {
        return { error_class: e.errorClass, error_code: e.errorCode, exit_code: e.exitCode };
    }
    return sanitizeError(e);
}

// Most clients read `mcpServers`; VS Code reads `servers` and wants an
// explicit transport `type`. Both take the same npx command shape.
function mcpServersEntry(apiKey: string): Record<string, unknown> {
    return { command: "npx", args: NPX_ARGS, env: { OMNIDIM_API_KEY: apiKey } };
}
function vscodeEntry(apiKey: string): Record<string, unknown> {
    return { type: "stdio", command: "npx", args: NPX_ARGS, env: { OMNIDIM_API_KEY: apiKey } };
}

// Filesystem errno -> a specific, PII-free error category. Lets telemetry say
// "permission denied" vs "disk full" vs "read-only" instead of one vague code.
const FS_ERROR_CODES: Record<string, string> = {
    EACCES: "config_permission_denied",
    EPERM: "config_permission_denied",
    EROFS: "config_readonly_fs",
    ENOSPC: "config_no_space",
};

function fsError(e: unknown, fallback: string): ClientInstallError {
    const code = (e as { code?: string }).code;
    const errorCode = (typeof code === "string" && FS_ERROR_CODES[code]) || fallback;
    return new ClientInstallError(
        e instanceof Error ? e.message : String(e),
        errorCode,
        e instanceof Error ? e.name : "Error",
    );
}

// Read a client's existing config. A missing OR empty/whitespace-only file is
// treated as a fresh `{}` rather than an error: a created-but-unwritten config
// file is a common state (the cause of "Unexpected end of JSON input"). A file
// holding valid JSON that isn't an object is also reset, since we can't merge
// a server map into it. Only genuinely malformed JSON is a hard failure.
function readConfig(configPath: string): Record<string, unknown> {
    if (!existsSync(configPath)) return {};
    let raw: string;
    try {
        raw = readFileSync(configPath, "utf8");
    } catch (e) {
        throw fsError(e, "config_read_error");
    }
    if (!raw.trim()) return {};
    try {
        const parsed = JSON.parse(raw) as unknown;
        return parsed && typeof parsed === "object" && !Array.isArray(parsed)
            ? (parsed as Record<string, unknown>)
            : {};
    } catch (e) {
        throw new ClientInstallError(
            e instanceof Error ? e.message : String(e),
            "config_invalid_json",
            e instanceof Error ? e.name : "Error",
        );
    }
}

// Merge our server entry into a JSON config under `topKey`, creating the file
// and parent directory if absent and preserving any other servers already
// there. Failures surface as a sanitized category for the setup funnel.
function upsertConfig(configPath: string, topKey: string, entry: Record<string, unknown>): void {
    const config = readConfig(configPath);
    const servers = ((config[topKey] as Record<string, unknown>) ?? {}) as Record<string, unknown>;
    servers.omnidim = entry;
    config[topKey] = servers;
    try {
        mkdirSync(dirname(configPath), { recursive: true });
        writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n");
    } catch (e) {
        throw fsError(e, "config_write_error");
    }
}

function installClaudeCode(apiKey: string): void {
    try {
        execFileSync("claude", ["mcp", "remove", "omnidim", "--scope", "user"], { stdio: "ignore" });
    } catch {
        // not registered, fine
    }
    try {
        // Name before the variadic -e so commander doesn't gobble it as an env value.
        execFileSync(
            "claude",
            [
                "mcp", "add", "omnidim",
                "--scope", "user",
                "-e", `OMNIDIM_API_KEY=${apiKey}`,
                "--", "npx", "-y", PKG,
            ],
            { stdio: ["ignore", "pipe", "pipe"] },
        );
    } catch (e) {
        const err = e as { stderr?: Buffer; stdout?: Buffer; message: string; code?: string; status?: number };
        const detail = (err.stderr ?? err.stdout ?? Buffer.from("")).toString().trim();
        if (err.code === "ENOENT") {
            throw new ClientInstallError("Claude Code CLI not found on PATH", "claude_cli_not_found", "Error");
        }
        const exitCode = typeof err.status === "number" ? err.status : undefined;
        throw new ClientInstallError(detail || err.message, "claude_cli_error", "Error", exitCode);
    }
}

// Claude Code is present if it has written its config or the CLI resolves.
function hasClaudeCli(env: HostEnv): boolean {
    if (existsSync(join(env.home, ".claude.json"))) return true;
    try {
        execFileSync("claude", ["--version"], { stdio: "ignore" });
        return true;
    } catch {
        return false;
    }
}

// macOS / Windows app-support dir for Claude Desktop (no official Linux build).
function claudeDesktopDir(env: HostEnv): string | null {
    if (env.platform === "darwin") {
        return join(env.home, "Library", "Application Support", "Claude");
    }
    if (env.platform === "win32") {
        return join(env.appData, "Claude");
    }
    return null;
}

function vscodeUserDir(env: HostEnv): string {
    if (env.platform === "darwin") {
        return join(env.home, "Library", "Application Support", "Code", "User");
    }
    if (env.platform === "win32") {
        return join(env.appData, "Code", "User");
    }
    return join(env.xdgConfig, "Code", "User");
}

// Resolve the install targets for the given host. Paths differ per platform,
// so this is computed at call time rather than as a static table.
export function buildTargets(env: HostEnv = currentHostEnv()): ClientTarget[] {
    const targets: ClientTarget[] = [
        {
            name: "Claude Code",
            id: "claude_code",
            detect: () => hasClaudeCli(env),
            install: installClaudeCode,
        },
    ];

    const claudeDir = claudeDesktopDir(env);
    if (claudeDir) {
        const configPath = join(claudeDir, "claude_desktop_config.json");
        targets.push({
            name: "Claude Desktop",
            id: "claude_desktop",
            detect: () => existsSync(claudeDir),
            install: (key) => upsertConfig(configPath, "mcpServers", mcpServersEntry(key)),
        });
    }

    const cursorDir = join(env.home, ".cursor");
    targets.push({
        name: "Cursor",
        id: "cursor",
        detect: () => existsSync(cursorDir),
        install: (key) => upsertConfig(join(cursorDir, "mcp.json"), "mcpServers", mcpServersEntry(key)),
    });

    const windsurfDir = join(env.home, ".codeium", "windsurf");
    targets.push({
        name: "Windsurf",
        id: "windsurf",
        detect: () => existsSync(windsurfDir),
        install: (key) =>
            upsertConfig(join(windsurfDir, "mcp_config.json"), "mcpServers", mcpServersEntry(key)),
    });

    const codeUserDir = vscodeUserDir(env);
    targets.push({
        name: "VS Code",
        id: "vscode",
        detect: () => existsSync(dirname(codeUserDir)),
        install: (key) => upsertConfig(join(codeUserDir, "mcp.json"), "servers", vscodeEntry(key)),
    });

    return targets;
}
