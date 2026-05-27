import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";

const ENDPOINT = "https://mcp.omnidim.io/api/telemetry/event";
const CONFIG_DIR = join(homedir(), ".config", "omnidim");
const INSTALL_ID_PATH = join(CONFIG_DIR, "install-id");
export const DISABLED_MARKER_PATH = join(CONFIG_DIR, "telemetry-disabled");
const PACKAGE_NAME = "@omnidim-ai/mcp-server";
const TIMEOUT_MS = 2500;

export function isTelemetryDisabled(): boolean {
    const env = (k: string): string => (process.env[k] ?? "").trim().toLowerCase();
    if (["1", "true", "yes"].includes(env("DO_NOT_TRACK"))) return true;
    if (["0", "false", "off", "no"].includes(env("OMNIDIM_TELEMETRY"))) return true;
    if (existsSync(DISABLED_MARKER_PATH)) return true;
    return false;
}

export function telemetryStatus(): { disabled: boolean; reason: string } {
    const env = (k: string): string => (process.env[k] ?? "").trim().toLowerCase();
    if (["1", "true", "yes"].includes(env("DO_NOT_TRACK"))) {
        return { disabled: true, reason: "DO_NOT_TRACK env var is set" };
    }
    if (["0", "false", "off", "no"].includes(env("OMNIDIM_TELEMETRY"))) {
        return { disabled: true, reason: "OMNIDIM_TELEMETRY env var is set" };
    }
    if (existsSync(DISABLED_MARKER_PATH)) {
        return { disabled: true, reason: `marker file at ${DISABLED_MARKER_PATH}` };
    }
    return { disabled: false, reason: "" };
}

function loadOrCreateInstallId(): string {
    try {
        if (existsSync(INSTALL_ID_PATH)) {
            const v = readFileSync(INSTALL_ID_PATH, "utf8").trim();
            if (v.length >= 8 && v.length <= 64) return v;
        }
    } catch {
        // fall through to create a fresh one
    }
    const id = randomUUID();
    try {
        mkdirSync(dirname(INSTALL_ID_PATH), { recursive: true });
        writeFileSync(INSTALL_ID_PATH, id, { mode: 0o600 });
    } catch {
        // anonymous, ephemeral if filesystem isn't writable
    }
    return id;
}

interface BaseFields {
    package_version: string;
    node_version?: string;
    os_platform?: string;
    os_arch?: string;
}

function baseFields(): BaseFields {
    let version = "unknown";
    try {
        const pkg = JSON.parse(
            readFileSync(new URL("../package.json", import.meta.url), "utf8")
        ) as { version?: string };
        version = pkg.version ?? "unknown";
    } catch {
        // keep "unknown"
    }
    return {
        package_version: version,
        node_version: process.version,
        os_platform: process.platform,
        os_arch: process.arch,
    };
}

async function send(event: string, extra: Record<string, unknown> = {}): Promise<void> {
    if (isTelemetryDisabled()) return;
    const body = {
        event,
        install_id: loadOrCreateInstallId(),
        package: PACKAGE_NAME,
        ...baseFields(),
        ...extra,
    };
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
        await fetch(ENDPOINT, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(body),
            signal: controller.signal,
        });
    } catch {
        // telemetry failures must never affect the actual user experience
    } finally {
        clearTimeout(timer);
    }
}

export interface SanitizedError {
    error_class: string;
    error_code: string;
}

// Reduce any thrown value to two low-cardinality, non-identifying fields.
// Never returns a message, stack, path, or payload, since those can carry
// usernames and file paths. Node's documented errno strings (ENOENT,
// EACCES, ...) and the error constructor name are safe to keep.
export function sanitizeError(error: unknown): SanitizedError {
    if (error && typeof error === "object") {
        const e = error as { name?: unknown; code?: unknown; constructor?: { name?: string } };
        const rawName =
            typeof e.name === "string" && e.name ? e.name : e.constructor?.name ?? "Error";
        const error_class = /^[A-Za-z][A-Za-z0-9]{0,39}$/.test(rawName) ? rawName : "Error";
        const error_code =
            typeof e.code === "string" && /^[A-Z][A-Z0-9_]{1,31}$/.test(e.code) ? e.code : "unknown";
        return { error_class, error_code };
    }
    return { error_class: "Error", error_code: "unknown" };
}

export async function emitInstall(): Promise<void> {
    await send("install");
}

export async function emitSessionStart(): Promise<void> {
    await send("session_start");
}

export type SetupKeyOutcome =
    | "reused"
    | "entered"
    | "rejected_401"
    | "network_error"
    | "server_error"
    | "aborted";

export async function emitSetupStarted(): Promise<void> {
    await send("setup_started");
}

export async function emitSetupKeyResult(outcome: SetupKeyOutcome): Promise<void> {
    await send("setup_key_result", { outcome });
}

export async function emitSetupClientResult(
    client: string,
    outcome: "installed" | "failed",
    error?: SanitizedError & { exit_code?: number },
): Promise<void> {
    await send("setup_client_result", { client, outcome, ...(error ?? {}) });
}

export async function emitSetupFinished(
    clientsInstalled: number,
    clientsFailed: number,
): Promise<void> {
    await send("setup_finished", {
        clients_installed: clientsInstalled,
        clients_failed: clientsFailed,
    });
}

interface ToolUsage {
    tool: string;
    count: number;
    ok: number;
    errors: Array<{ code: string; count: number }>;
}

export interface SessionSummary {
    duration_s: number;
    tools_called: ToolUsage[];
    tool_errors_total: number;
}

interface ToolStat {
    count: number;
    ok: number;
    errors: Map<string, number>;
}

const toolStats = new Map<string, ToolStat>();
let sessionStartMs: number | null = null;
// Guards against one session reporting twice (a crash racing graceful
// shutdown), which would otherwise log an empty ghost event.
let terminated = false;

// outcome is "ok" for a successful call, otherwise a category code
// ("http_401", "network", "timeout", "validation", "upstream_html",
// "no_api_key", "unknown"). Never a tool's input or output.
export function recordToolResult(name: string, outcome: string): void {
    let stat = toolStats.get(name);
    if (!stat) {
        stat = { count: 0, ok: 0, errors: new Map() };
        toolStats.set(name, stat);
    }
    stat.count += 1;
    if (outcome === "ok") {
        stat.ok += 1;
    } else {
        stat.errors.set(outcome, (stat.errors.get(outcome) ?? 0) + 1);
    }
}

export function beginSession(): void {
    sessionStartMs = Date.now();
    terminated = false;
    void emitSessionStart();
}

function drainSession(): SessionSummary {
    const duration_s = sessionStartMs ? Math.round((Date.now() - sessionStartMs) / 1000) : 0;
    let tool_errors_total = 0;
    const tools_called: ToolUsage[] = Array.from(toolStats.entries()).map(([tool, stat]) => {
        const errors = Array.from(stat.errors.entries()).map(([code, count]) => {
            tool_errors_total += count;
            return { code, count };
        });
        return { tool, count: stat.count, ok: stat.ok, errors };
    });
    sessionStartMs = null;
    toolStats.clear();
    return { duration_s, tools_called, tool_errors_total };
}

export function endSession(): SessionSummary {
    return drainSession();
}

export async function emitSessionEnd(payload: SessionSummary): Promise<void> {
    if (terminated) return;
    terminated = true;
    await send("session_end", { ...payload });
}

// Fires on a crash so the session still terminates with a record carrying
// its tool-call summary; a clean session_end never runs on a crash path.
export async function emitSessionCrash(error: unknown): Promise<void> {
    if (terminated) return;
    terminated = true;
    const active = sessionStartMs !== null;
    const summary = drainSession();
    await send("session_crash", {
        phase: active ? "runtime" : "startup",
        ...sanitizeError(error),
        ...summary,
    });
}
