import { mkdtempSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let CREDENTIALS_PATH: string;
let readApiKey: () => string | null;
let writeApiKey: (key: string) => string;

beforeEach(async () => {
    const tmp = mkdtempSync(`${tmpdir()}/omnidim-test-`);
    vi.stubEnv("HOME", tmp);
    vi.resetModules();
    const mod = await import("../src/credentials.js");
    CREDENTIALS_PATH = mod.CREDENTIALS_PATH;
    readApiKey = mod.readApiKey;
    writeApiKey = mod.writeApiKey;
});

afterEach(() => {
    vi.unstubAllEnvs();
});

describe("credentials", () => {
    it("returns null when the file does not exist", () => {
        expect(readApiKey()).toBeNull();
    });

    it("writes the key under $HOME/.config/omnidim/credentials", () => {
        const path = writeApiKey("sk_test_abc");
        expect(path).toBe(CREDENTIALS_PATH);
        expect(readApiKey()).toBe("sk_test_abc");
    });

    it("writes with 0600 permissions", () => {
        writeApiKey("sk_secret");
        const mode = statSync(CREDENTIALS_PATH).mode & 0o777;
        expect(mode).toBe(0o600);
    });

    it("trims surrounding whitespace on read", () => {
        writeApiKey("sk_padded");
        expect(readApiKey()).toBe("sk_padded");
    });

    it("returns null for a blank file", () => {
        writeApiKey("");
        expect(readApiKey()).toBeNull();
    });
});
