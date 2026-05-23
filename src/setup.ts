import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";

import axios from "axios";

import { writeApiKey } from "./credentials.js";
import { printAnimatedSetupBanner } from "./helpers.js";

const PROD_API = "https://backend.omnidim.io/api/v1";

const dim = (s: string): string => `\x1b[2m${s}\x1b[0m`;
const teal = (s: string): string => `\x1b[38;5;30m${s}\x1b[0m`;
const red = (s: string): string => `\x1b[31m${s}\x1b[0m`;

interface ClientTarget {
    name: string;
    configPath: string;
    install: (apiKey: string) => void;
}

const TARGETS: ClientTarget[] = [
    {
        name: "Claude Code",
        configPath: join(homedir(), ".claude.json"),
        install: installClaudeCode,
    },
    {
        name: "Claude Desktop",
        configPath: join(
            homedir(),
            "Library",
            "Application Support",
            "Claude",
            "claude_desktop_config.json",
        ),
        install: (key) => upsertJsonConfig(TARGETS[1].configPath, key),
    },
    {
        name: "Cursor",
        configPath: join(homedir(), ".cursor", "mcp.json"),
        install: (key) => upsertJsonConfig(TARGETS[2].configPath, key),
    },
    {
        name: "Windsurf",
        configPath: join(homedir(), ".codeium", "windsurf", "mcp_config.json"),
        install: (key) => upsertJsonConfig(TARGETS[3].configPath, key),
    },
];

function upsertJsonConfig(configPath: string, apiKey: string): void {
    const config = existsSync(configPath)
        ? (JSON.parse(readFileSync(configPath, "utf8")) as Record<string, unknown>)
        : {};
    const servers = ((config.mcpServers as Record<string, unknown>) ?? {}) as Record<string, unknown>;
    servers.omnidim = {
        command: "npx",
        args: ["-y", "@omnidim-ai/mcp-server"],
        env: { OMNIDIM_API_KEY: apiKey },
    };
    config.mcpServers = servers;
    writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n");
}

function installClaudeCode(apiKey: string): void {
    try {
        execFileSync("claude", ["mcp", "remove", "--scope", "user", "omnidim"], { stdio: "ignore" });
    } catch {
        // not registered, fine
    }
    execFileSync(
        "claude",
        [
            "mcp", "add", "--scope", "user",
            "-e", `OMNIDIM_API_KEY=${apiKey}`,
            "omnidim", "--", "npx", "-y", "@omnidim-ai/mcp-server",
        ],
        { stdio: "ignore" },
    );
}

async function validateApiKey(apiKey: string): Promise<string | null> {
    try {
        const res = await axios.get(`${PROD_API}/agents`, {
            params: { pagesize: 1 },
            headers: { Authorization: `Bearer ${apiKey}` },
            timeout: 10_000,
            validateStatus: () => true,
        });
        if (res.status === 200) return null;
        if (res.status === 401) return "key rejected by server";
        return `unexpected status ${res.status}`;
    } catch (e) {
        return e instanceof Error ? e.message : "network error";
    }
}

export async function runSetup(): Promise<number> {
    await printAnimatedSetupBanner();
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    try {
        process.stdout.write(`  Get a key at ${dim("omnidim.io/api-management")}\n`);

        let apiKey = "";
        for (let i = 0; i < 3 && !apiKey; i++) {
            const input = (await rl.question("  API key: ")).trim();
            if (!input) {
                process.stdout.write(red("  empty input, try again\n"));
                continue;
            }
            process.stdout.write(`  ${dim("checking...")}\n`);
            const err = await validateApiKey(input);
            if (err === null) {
                apiKey = input;
                break;
            }
            process.stdout.write(red(`  ${err}, try again\n`));
        }
        if (!apiKey) {
            process.stdout.write(red("\n  three failed attempts, aborting.\n"));
            return 1;
        }

        const path = writeApiKey(apiKey);
        process.stdout.write(`  ${teal("●")} key saved to ${dim(path)}\n\n`);

        const detected = TARGETS.filter((t) => existsSync(t.configPath));
        if (detected.length === 0) {
            process.stdout.write(`  ${dim("no MCP clients detected. Add manually:")}\n`);
            process.stdout.write(`    claude mcp add omnidim -- npx -y @omnidim-ai/mcp-server\n\n`);
            return 0;
        }

        process.stdout.write("  Detected:\n");
        for (const t of detected) process.stdout.write(`    ${dim("•")} ${t.name}\n`);

        const ans = (await rl.question("\n  Install for all? [Y/n] ")).trim().toLowerCase();
        if (ans === "n" || ans === "no") return 0;

        for (const t of detected) {
            try {
                t.install(apiKey);
                process.stdout.write(`  ${teal("●")} installed for ${t.name}\n`);
            } catch (e) {
                const msg = e instanceof Error ? e.message : String(e);
                process.stdout.write(red(`  failed for ${t.name}: ${msg}\n`));
            }
        }
        process.stdout.write(`\n  ${dim("restart your MCP client to start using OmniDim.")}\n\n`);
        return 0;
    } finally {
        rl.close();
    }
}
