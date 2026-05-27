import { readFileSync } from "node:fs";

import axios from "axios";

import { buildTargets } from "./clients.js";
import { readApiKey } from "./credentials.js";
import { LOG_PATH, readLogTail } from "./logger.js";
import { telemetryStatus } from "./telemetry.js";

const PROD_API = "https://backend.omnidim.io/api/v1";
const ISSUES_URL = "https://github.com/Omnidim/omnidim-mcp-server/issues/new";

function packageVersion(): string {
    try {
        const pkg = JSON.parse(
            readFileSync(new URL("../package.json", import.meta.url), "utf8"),
        ) as { version?: string };
        return pkg.version ?? "unknown";
    } catch {
        return "unknown";
    }
}

async function probeBackend(apiKey: string | null): Promise<string> {
    try {
        const res = await axios.get(`${PROD_API}/agents`, {
            params: { pagesize: 1 },
            headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
            timeout: 8000,
            validateStatus: () => true,
        });
        if (res.status === 200) return "reachable, key accepted (200)";
        if (res.status === 401) return apiKey ? "reachable, key rejected (401)" : "reachable (401, no key)";
        return `reachable, unexpected status ${res.status}`;
    } catch (e) {
        const code = (e as { code?: string }).code;
        return `unreachable (${code ?? (e instanceof Error ? e.message : "error")})`;
    }
}

export async function runDoctor(): Promise<number> {
    const envKey = process.env.OMNIDIM_API_KEY;
    const savedKey = readApiKey();
    const apiKey = envKey || savedKey;
    const keyState = envKey ? "set (env)" : savedKey ? "set (saved file)" : "not set";

    const backend = await probeBackend(apiKey);
    const tel = telemetryStatus();
    const clients = buildTargets().map((t) => `${t.name}: ${t.detect() ? "detected" : "not installed"}`);
    const log = readLogTail(20);

    const lines = [
        "OmniDimension MCP server — doctor",
        "",
        `  package    @omnidim-ai/mcp-server ${packageVersion()}`,
        `  node       ${process.version}`,
        `  os         ${process.platform} ${process.arch}`,
        `  api key    ${keyState}`,
        `  backend    ${PROD_API} — ${backend}`,
        `  clients    ${clients.join(" · ")}`,
        `  telemetry  ${tel.disabled ? `disabled (${tel.reason})` : "enabled"}`,
        `  log        ${LOG_PATH}`,
        "",
    ];
    if (log.length) {
        lines.push("  recent errors (oldest first):");
        for (const line of log) lines.push(`    ${line}`);
    } else {
        lines.push("  recent errors: none logged");
    }
    lines.push("", `  Report an issue: ${ISSUES_URL}`, "  Copy everything above into the issue.", "");

    process.stdout.write(lines.join("\n") + "\n");
    return 0;
}
