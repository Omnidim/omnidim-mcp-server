import { renderWordmark } from "./banner.js";

export const PACKAGE_NAME = "@omnidim-ai/mcp-server";

const bold = (s: string): string => `\x1b[1m${s}\x1b[0m`;
const italic = (s: string): string => `\x1b[3m${s}\x1b[0m`;
const dim = (s: string): string => `\x1b[2m${s}\x1b[0m`;

function brand(): string {
    return `${bold("OmniDimension")} ${dim("·")} ${italic("Voice AI")} MCP Server`;
}

export function isInteractive(): boolean {
    return Boolean(process.stdin.isTTY && process.stdout.isTTY);
}

export function printInteractiveHelp(version: string): void {
    const lines = [
        "",
        `  ${brand()}   ${dim(`v${version}`)}`,
        "",
        `  ${bold("Claude Code")}`,
        `    claude mcp add omnidim -e OMNIDIM_API_KEY=... -- npx -y ${PACKAGE_NAME}`,
        "",
        `  ${bold("Claude Desktop · Cursor · Windsurf")}`,
        '      "omnidim": {',
        '        "command": "npx",',
        `        "args": ["-y", "${PACKAGE_NAME}"],`,
        '        "env": { "OMNIDIM_API_KEY": "your_key" }',
        "      }",
        "",
        `  ${dim("API key")}   omnidim.io/api-management`,
        `  ${dim("Docs")}      https://docs.omnidim.io`,
        "",
    ];
    process.stdout.write(lines.join("\n") + "\n");
}

export function startupBanner(version: string, toolCount: number): string {
    return `\n  ${brand()}   ${dim(`v${version} · ${toolCount} tools`)}\n`;
}

const teal = (s: string): string => `\x1b[38;5;30m${s}\x1b[0m`;

const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const BRAND_GLYPH = "●";

function brandLine(glyph: string): string {
    return `  ${teal(glyph)}  ${bold("OmniDimension")} ${dim("·")} ${italic("Voice AI")}`;
}

const SUBTITLE = `     ${dim("MCP server setup")} ${dim("·")} ${dim("omnidim.io")}`;

export async function printAnimatedSetupBanner(): Promise<void> {
    if (!process.stdout.isTTY) {
        printSetupBanner();
        return;
    }
    // Wide TTY: show the full branded wordmark instead of the spinner line.
    const wordmark = renderWordmark(process.stdout.columns);
    if (wordmark) {
        process.stdout.write("\n" + wordmark + "\n\n");
        process.stdout.write(`  ${bold("OmniDimension")} ${dim("·")} ${italic("Voice AI")}\n`);
        process.stdout.write(SUBTITLE + "\n\n");
        return;
    }
    process.stdout.write("\n");
    process.stdout.write("\x1b[?25l");
    try {
        for (let i = 0; i < 16; i++) {
            process.stdout.write(`\r${brandLine(SPINNER[i % SPINNER.length])}`);
            await new Promise((r) => setTimeout(r, 70));
        }
        process.stdout.write(`\r${brandLine(BRAND_GLYPH)}`);
    } finally {
        process.stdout.write("\x1b[?25h");
    }
    process.stdout.write("\n");
    process.stdout.write(SUBTITLE + "\n\n");
}

export function printSetupBanner(): void {
    const lines = ["", brandLine(BRAND_GLYPH), SUBTITLE, ""];
    process.stdout.write(lines.join("\n") + "\n");
}

export const MAX_LIST_CHARS = 25000;

export const LIST_KEYS = [
    "bots",
    "call_log_data",
    "records",
    "files",
    "phone_numbers",
    "llms",
    "voices",
    "stt",
    "tts",
    "services",
    "organizations",
    "data",
    "results",
    "items",
];

// Reseller list endpoints return child orgs' plaintext api_key values.
// Strip them before they reach the model.
export function redactSensitive(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(redactSensitive);
    if (value && typeof value === "object") {
        const out: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(value)) {
            out[k] = k === "api_key" ? "[redacted]" : redactSensitive(v);
        }
        return out;
    }
    return value;
}

export function findList(data: unknown): { arr: unknown[]; key: string | null } | null {
    if (Array.isArray(data)) return { arr: data, key: null };
    if (!data || typeof data !== "object") return null;
    const obj = data as Record<string, unknown>;
    for (const k of LIST_KEYS) {
        const candidate = obj[k];
        if (Array.isArray(candidate)) return { arr: candidate, key: k };
    }
    return null;
}

// Trim list responses to fit a model context budget. Single-resource
// responses are never trimmed; an oversized payload from getAgent etc.
// is handled by the MCP client (spill-to-file + chunked read).
export function trimLargeResponse(data: unknown): { text: string; note?: string } {
    const redacted = redactSensitive(data);
    const full = JSON.stringify(redacted, null, 2);
    const list = findList(redacted);

    if (!list || full.length <= MAX_LIST_CHARS) return { text: full };

    const { arr, key } = list;
    let kept = arr.length;
    while (kept > 1) {
        const trimmed = arr.slice(0, kept);
        const candidate = key
            ? JSON.stringify({ ...(redacted as Record<string, unknown>), [key]: trimmed }, null, 2)
            : JSON.stringify(trimmed, null, 2);
        if (candidate.length <= MAX_LIST_CHARS) {
            return {
                text: candidate,
                note: `[Showing ${kept} of ${arr.length} items. Lower pagesize, filter by name, or fetch a specific item by ID for full detail.]`,
            };
        }
        kept = Math.max(1, Math.floor(kept * 0.6));
    }

    return {
        text: full.slice(0, MAX_LIST_CHARS),
        note: `[Response truncated. Full size: ${full.length} chars.]`,
    };
}

const NAMED_STATUSES = new Set([400, 401, 403, 404, 409, 422, 429, 500, 502, 503]);

// Map a thrown tool-call error to a low-cardinality category for telemetry.
// Duck-typed on the axios error shape so this stays testable without axios.
// Returns a status/network/timeout category, never a URL, body, or input.
export function classifyToolError(error: unknown): string {
    if (error && typeof error === "object") {
        const e = error as {
            isAxiosError?: boolean;
            code?: unknown;
            name?: unknown;
            response?: { status?: unknown };
        };
        if (e.name === "ZodError") return "validation";
        if (e.isAxiosError) {
            const status = e.response?.status;
            if (typeof status === "number") {
                if (NAMED_STATUSES.has(status)) return `http_${status}`;
                if (status >= 500) return "http_5xx";
                if (status >= 400) return "http_4xx";
                return `http_${status}`;
            }
            if (e.code === "ECONNABORTED" || e.code === "ETIMEDOUT") return "timeout";
            return "network";
        }
    }
    return "unknown";
}
