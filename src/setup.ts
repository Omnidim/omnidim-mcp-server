import { createInterface, Interface as ReadlineInterface } from "node:readline/promises";

import axios from "axios";

import { buildTargets, describeInstallError } from "./clients.js";
import { CREDENTIALS_PATH, readApiKey, writeApiKey } from "./credentials.js";
import { printAnimatedSetupBanner } from "./helpers.js";
import { appendLog } from "./logger.js";
import {
    emitInstall,
    emitSetupClientResult,
    emitSetupFinished,
    emitSetupKeyResult,
    emitSetupStarted,
    isTelemetryDisabled,
    type SetupKeyOutcome,
} from "./telemetry.js";

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

type KeyFailureReason = "rejected_401" | "network_error" | "unexpected";

type KeyCheck = { ok: true } | { ok: false; reason: KeyFailureReason; message: string };

// Maps the last key-check failure to the telemetry outcome. `null` means the
// user never submitted a key (only empty input), i.e. a genuine abort.
export function keyOutcomeFromReason(reason: KeyFailureReason | null): SetupKeyOutcome {
    switch (reason) {
        case "rejected_401":
            return "rejected_401";
        case "network_error":
            return "network_error";
        case "unexpected":
            return "server_error";
        default:
            return "aborted";
    }
}

async function validateApiKey(apiKey: string): Promise<KeyCheck> {
    try {
        const res = await axios.get(`${PROD_API}/agents`, {
            params: { pagesize: 1 },
            headers: { Authorization: `Bearer ${apiKey}` },
            timeout: 10_000,
            validateStatus: () => true,
        });
        if (res.status === 200) return { ok: true };
        if (res.status === 401) return { ok: false, reason: "rejected_401", message: "Uh oh! Key rejected" };
        return { ok: false, reason: "unexpected", message: `unexpected status ${res.status}` };
    } catch (e) {
        return { ok: false, reason: "network_error", message: e instanceof Error ? e.message : "network error" };
    }
}

export async function runSetup(): Promise<number> {
    await printAnimatedSetupBanner();
    void emitSetupStarted();

    let rl: ReadlineInterface | null = null;
    try {
        let apiKey = "";

        // If we already have a saved key, validate it and offer to reuse.
        const saved = readApiKey();
        if (saved) {
            process.stdout.write(`  Saved key found at ${dim(CREDENTIALS_PATH)}\n`);
            process.stdout.write(`  ${dim("checking...")}\n`);
            const check = await validateApiKey(saved);
            if (check.ok) {
                rl = createInterface({ input: process.stdin, output: process.stdout });
                const ans = (await rl.question("  Reuse this key? [Y/n] ")).trim().toLowerCase();
                rl.close();
                rl = null;
                if (ans !== "n" && ans !== "no") {
                    apiKey = saved;
                    void emitSetupKeyResult("reused");
                    process.stdout.write(`  ${teal("●")} using saved key\n\n`);
                }
            } else {
                process.stdout.write(red(`  saved key: ${check.message}\n`));
            }
        }

        if (!apiKey) {
            process.stdout.write(`  Get a key at ${dim("omnidim.io/api-management")}\n`);
            let lastReason: KeyFailureReason | null = null;
            for (let i = 0; i < 3 && !apiKey; i++) {
                const input = (await readMaskedLine("  API key: ")).trim();
                if (!input) {
                    process.stdout.write(red("  empty input, try again\n"));
                    continue;
                }
                process.stdout.write(`  ${dim("checking...")}\n`);
                const check = await validateApiKey(input);
                if (check.ok) {
                    apiKey = input;
                    break;
                }
                lastReason = check.reason;
                process.stdout.write(red(`  ${check.message}, try again\n`));
            }
            if (!apiKey) {
                void emitSetupKeyResult(keyOutcomeFromReason(lastReason));
                process.stdout.write(red("\n  three failed attempts, aborting.\n"));
                return 1;
            }

            void emitSetupKeyResult("entered");
            const path = writeApiKey(apiKey);
            process.stdout.write(`  ${teal("●")} key saved to ${dim(path)}\n\n`);
        }

        const detected = buildTargets().filter((t) => t.detect());
        if (detected.length === 0) {
            void emitSetupFinished(0, 0);
            process.stdout.write(`  ${dim("no MCP clients detected. Add manually:")}\n`);
            process.stdout.write(`    claude mcp add omnidim -- npx -y @omnidim-ai/mcp-server\n\n`);
            return 0;
        }

        process.stdout.write("  Detected:\n");
        for (const t of detected) process.stdout.write(`    ${dim("•")} ${t.name}\n`);

        rl = createInterface({ input: process.stdin, output: process.stdout });
        const ans = (await rl.question("\n  Install for all? [Y/n] ")).trim().toLowerCase();
        if (ans === "n" || ans === "no") {
            void emitSetupFinished(0, 0);
            return 0;
        }

        let installed = 0;
        let failed = 0;
        for (const t of detected) {
            try {
                t.install(apiKey);
                installed++;
                void emitSetupClientResult(t.id, "installed");
                process.stdout.write(`  ${teal("●")} installed for ${t.name}\n`);
            } catch (e) {
                failed++;
                const detail = describeInstallError(e);
                void emitSetupClientResult(t.id, "failed", detail);
                const msg = e instanceof Error ? e.message : String(e);
                appendLog({ kind: "setup", step: "client_install", client: t.id, code: detail.error_code, message: msg });
                process.stdout.write(red(`  failed for ${t.name}: ${msg}\n`));
                process.stdout.write(
                    dim(`    add manually: claude mcp add omnidim -- npx -y @omnidim-ai/mcp-server\n`),
                );
            }
        }
        void emitSetupFinished(installed, failed);
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
