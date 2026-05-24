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

export async function emitInstall(): Promise<void> {
    await send("install");
}

export async function emitSessionStart(): Promise<void> {
    await send("session_start");
}

interface SessionEndPayload {
    duration_s: number;
    tools_called: Array<{ tool: string; count: number }>;
}

export async function emitSessionEnd(payload: SessionEndPayload): Promise<void> {
    await send("session_end", { ...payload });
}

const toolCounts = new Map<string, number>();
let sessionStartMs: number | null = null;

export function recordToolCall(name: string): void {
    toolCounts.set(name, (toolCounts.get(name) ?? 0) + 1);
}

export function beginSession(): void {
    sessionStartMs = Date.now();
    void emitSessionStart();
}

export function endSession(): SessionEndPayload {
    const duration_s = sessionStartMs ? Math.round((Date.now() - sessionStartMs) / 1000) : 0;
    const tools_called = Array.from(toolCounts.entries()).map(([tool, count]) => ({ tool, count }));
    sessionStartMs = null;
    toolCounts.clear();
    return { duration_s, tools_called };
}
