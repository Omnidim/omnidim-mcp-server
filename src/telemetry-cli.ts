import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import { DISABLED_MARKER_PATH, telemetryStatus } from "./telemetry.js";

const dim = (s: string): string => `\x1b[2m${s}\x1b[0m`;
const teal = (s: string): string => `\x1b[38;5;30m${s}\x1b[0m`;
const red = (s: string): string => `\x1b[31m${s}\x1b[0m`;

const USAGE = `  ${dim("Usage:")} omnidim-mcp-server telemetry <enable | disable | status>`;

function writeStatus(): void {
    const s = telemetryStatus();
    if (s.disabled) {
        process.stdout.write(`  ${teal("●")} Telemetry: ${red("disabled")} ${dim("(" + s.reason + ")")}\n`);
    } else {
        process.stdout.write(`  ${teal("●")} Telemetry: enabled\n`);
        process.stdout.write(
            `    ${dim("Details: omnidim.io/privacy-policy#telemetry")}\n`,
        );
    }
}

export async function runTelemetryCommand(action: string | undefined): Promise<number> {
    switch (action) {
        case "disable": {
            try {
                mkdirSync(dirname(DISABLED_MARKER_PATH), { recursive: true });
                writeFileSync(DISABLED_MARKER_PATH, "disabled\n", { mode: 0o600 });
            } catch (e) {
                const msg = e instanceof Error ? e.message : String(e);
                process.stdout.write(red(`  could not write marker: ${msg}\n`));
                return 1;
            }
            process.stdout.write(`  ${teal("●")} Telemetry disabled.\n`);
            return 0;
        }
        case "enable": {
            try {
                rmSync(DISABLED_MARKER_PATH, { force: true });
            } catch {
                // missing is fine
            }
            process.stdout.write(`  ${teal("●")} Telemetry enabled.\n`);
            process.stdout.write(
                `    ${dim("Note: DO_NOT_TRACK or OMNIDIM_TELEMETRY env vars still take precedence.")}\n`,
            );
            return 0;
        }
        case "status":
        case undefined: {
            writeStatus();
            return 0;
        }
        default: {
            process.stdout.write(red(`  unknown action: ${action}\n`));
            process.stdout.write(USAGE + "\n");
            return 2;
        }
    }
}
