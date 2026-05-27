import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const LOG_DIR = join(homedir(), ".config", "omnidim", "logs");
export const LOG_PATH = join(LOG_DIR, "mcp.log");
const MAX_BYTES = 256 * 1024;

// The log is local-only but the user may paste it into a public issue, so
// strip anything token-shaped before writing. The API key is never passed
// here, but an upstream library's error message can occasionally echo one.
export function scrubSecrets(s: string): string {
    return s
        .replace(/sk_[A-Za-z0-9_-]{6,}/g, "sk_[redacted]")
        .replace(/(bearer\s+)[A-Za-z0-9._-]{8,}/gi, "$1[redacted]")
        .replace(
            /("?(?:api[_-]?key|authorization|token)"?\s*[:=]\s*"?)[A-Za-z0-9._-]{8,}/gi,
            "$1[redacted]",
        );
}

export interface LogFields {
    kind: "tool_error" | "setup" | "crash";
    [key: string]: unknown;
}

export function appendLog(fields: LogFields): void {
    try {
        mkdirSync(LOG_DIR, { recursive: true });
        const line = scrubSecrets(JSON.stringify({ ts: new Date().toISOString(), ...fields }));
        appendFileSync(LOG_PATH, line + "\n", { mode: 0o600 });
        trimIfLarge();
    } catch {
        // logging must never affect the user experience
    }
}

// Keep the newest half when the file grows past the cap, so the log can't
// grow without bound on a long-lived or repeatedly-failing install.
function trimIfLarge(): void {
    try {
        if (!existsSync(LOG_PATH) || statSync(LOG_PATH).size <= MAX_BYTES) return;
        const lines = readFileSync(LOG_PATH, "utf8").split("\n");
        writeFileSync(LOG_PATH, lines.slice(Math.floor(lines.length / 2)).join("\n"), { mode: 0o600 });
    } catch {
        // ignore
    }
}

export function readLogTail(maxLines = 25): string[] {
    try {
        if (!existsSync(LOG_PATH)) return [];
        return readFileSync(LOG_PATH, "utf8").trimEnd().split("\n").filter(Boolean).slice(-maxLines);
    } catch {
        return [];
    }
}
