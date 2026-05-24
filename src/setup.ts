import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createInterface, Interface as ReadlineInterface } from "node:readline/promises";

import axios from "axios";

import { writeApiKey } from "./credentials.js";
import { printAnimatedSetupBanner } from "./helpers.js";
import { emitInstall, isTelemetryDisabled } from "./telemetry.js";

const PROD_API = "https://backend.omnidim.io/api/v1";

const dim = (s: string): string => `\x1b[2m${s}\x1b[0m`;
const italicDim = (s: string): string => `\x1b[2;3m${s}\x1b[0m`;
const teal = (s: string): string => `\x1b[38;5;30m${s}\x1b[0m`;
const red = (s: string): string => `\x1b[31m${s}\x1b[0m`;

const CLOSING_LINES = [
    "happy voice AI building",
    "let your agents do the talking",
    "time to ship some voice AI",
    "you're set. time to build.",
    "setup done. ready to ship your first voice AI agent?",
];

export function pickClosingLine(): string {
    return CLOSING_LINES[Math.floor(Math.random() * CLOSING_LINES.length)];
}

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
        execFileSync("claude", ["mcp", "remove", "omnidim"], { stdio: "ignore" });
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
                "--", "npx", "-y", "@omnidim-ai/mcp-server",
            ],
            { stdio: ["ignore", "pipe", "pipe"] },
        );
    } catch (e) {
        const err = e as { stderr?: Buffer; stdout?: Buffer; message: string };
        const detail = (err.stderr ?? err.stdout ?? Buffer.from("")).toString().trim();
        throw new Error(detail || err.message);
    }
}

// Echoes `*` per input char so pasted keys never land in scrollback.
function readMaskedLine(prompt: string): Promise<string> {
    process.stdout.write(prompt);
    const stdin = process.stdin;
    if (stdin.isTTY !== true) {
        const rl = createInterface({ input: stdin, output: process.stdout, terminal: false });
        return new Promise((resolve) => {
            let settled = false;
            const done = (line: string) => {
                if (settled) return;
                settled = true;
                rl.close();
                resolve(line);
            };
            rl.once("line", done);
            rl.once("close", () => done(""));
        });
    }
    return new Promise((resolve) => {
        let buf = "";
        const cleanup = () => {
            stdin.removeListener("data", onData);
            stdin.setRawMode(false);
            stdin.pause();
        };
        const finish = () => {
            cleanup();
            process.stdout.write("\n");
            resolve(buf);
        };
        const onData = (chunk: Buffer) => {
            const s = chunk.toString("utf8");
            for (const ch of s) {
                const code = ch.charCodeAt(0);
                if (ch === "\r" || ch === "\n") {
                    finish();
                    return;
                }
                if (code === 3) {
                    cleanup();
                    process.stdout.write("\n");
                    process.exit(130);
                }
                if (code === 127 || code === 8) {
                    if (buf.length > 0) {
                        buf = buf.slice(0, -1);
                        process.stdout.write("\b \b");
                    }
                    continue;
                }
                if (code < 32) continue;
                buf += ch;
                process.stdout.write("*");
            }
        };
        stdin.setRawMode(true);
        stdin.resume();
        stdin.on("data", onData);
    });
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
        if (res.status === 401) return "Uh oh! Key rejected";
        return `unexpected status ${res.status}`;
    } catch (e) {
        return e instanceof Error ? e.message : "network error";
    }
}

export async function runSetup(): Promise<number> {
    await printAnimatedSetupBanner();
    process.stdout.write(`  Get a key at ${dim("omnidim.io/api-management")}\n`);

    let rl: ReadlineInterface | null = null;
    try {
        let apiKey = "";
        for (let i = 0; i < 3 && !apiKey; i++) {
            const input = (await readMaskedLine("  API key: ")).trim();
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

        rl = createInterface({ input: process.stdin, output: process.stdout });
        const ans = (await rl.question("\n  Install for all? [Y/n] ")).trim().toLowerCase();
        if (ans === "n" || ans === "no") return 0;

        for (const t of detected) {
            try {
                t.install(apiKey);
                process.stdout.write(`  ${teal("●")} installed for ${t.name}\n`);
            } catch (e) {
                const msg = e instanceof Error ? e.message : String(e);
                process.stdout.write(red(`  failed for ${t.name}: ${msg}\n`));
                process.stdout.write(
                    dim(`    add manually: claude mcp add omnidim -- npx -y @omnidim-ai/mcp-server\n`),
                );
            }
        }
        if (isTelemetryDisabled()) {
            process.stdout.write(`\n  ${dim("Telemetry off")}\n`);
        } else {
            process.stdout.write(
                `\n  ${dim("Anonymous usage data helps us improve the package.")}\n`,
            );
            process.stdout.write(
                `  ${dim("Disable: npx -y @omnidim-ai/mcp-server telemetry disable")} ${dim("·")} ${dim("omnidim.io/privacy-policy#telemetry")}\n`,
            );
            void emitInstall();
        }
        process.stdout.write(`\n     ${italicDim(pickClosingLine())}\n\n`);
        return 0;
    } finally {
        rl?.close();
    }
}
