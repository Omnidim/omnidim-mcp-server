import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const BINARY = resolve(__dirname, "..", "build", "index.js");

async function callInOrder(calls: Record<string, unknown>[]): Promise<string[]> {
    const dir = mkdtempSync(join(tmpdir(), "omnidim-merged-"));
    const child = spawn("node", [BINARY], {
        env: { ...process.env, HOME: dir, USERPROFILE: dir, OMNIDIM_API_KEY: "sk_test", OMNIDIM_TELEMETRY: "off" },
        stdio: ["pipe", "pipe", "ignore"],
    });
    const waiting = new Map<number, (m: any) => void>();
    let buffer = "";
    child.stdout!.on("data", (chunk) => {
        buffer += chunk;
        for (let i = buffer.indexOf("\n"); i >= 0; i = buffer.indexOf("\n")) {
            const line = buffer.slice(0, i);
            buffer = buffer.slice(i + 1);
            try {
                const message = JSON.parse(line);
                waiting.get(message.id)?.(message);
            } catch {
                continue;
            }
        }
    });
    let id = 0;
    const rpc = (method: string, params: unknown) =>
        new Promise<any>((done) => {
            id += 1;
            waiting.set(id, done);
            child.stdin!.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
        });
    try {
        await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "0" } });
        const texts: string[] = [];
        for (const args of calls) {
            const reply = await rpc("tools/call", { name: "phoneNumberAgentActions", arguments: args });
            texts.push(reply.result.content[0].text);
        }
        return texts;
    } finally {
        child.kill();
        rmSync(dir, { recursive: true, force: true });
    }
}

describe("a merged tool on the built server", () => {
    it("checks each action against its own inputs, whatever ran before", async () => {
        const [attach, detach] = await callInOrder([
            { action: "attach", phone_number_id: "x", agent_id: "y" },
            { action: "detach", phone_number_id: "x" },
        ]);
        expect(attach).toContain("agent_id");
        expect(detach).toContain("phone_number_id");
        expect(detach).not.toContain("agent_id");
    }, 15_000);
});
