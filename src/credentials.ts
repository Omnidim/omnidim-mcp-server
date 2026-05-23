import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const CREDENTIALS_DIR = join(homedir(), ".config", "omnidim");
const CREDENTIALS_FILE = join(CREDENTIALS_DIR, "credentials");

export function readApiKey(): string | null {
    try {
        const raw = readFileSync(CREDENTIALS_FILE, "utf8").trim();
        return raw || null;
    } catch {
        return null;
    }
}

export function writeApiKey(apiKey: string): string {
    mkdirSync(dirname(CREDENTIALS_FILE), { recursive: true, mode: 0o700 });
    writeFileSync(CREDENTIALS_FILE, apiKey + "\n", { mode: 0o600 });
    return CREDENTIALS_FILE;
}

export const CREDENTIALS_PATH = CREDENTIALS_FILE;
