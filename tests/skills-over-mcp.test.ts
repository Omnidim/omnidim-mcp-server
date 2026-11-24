import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const BINARY = resolve(__dirname, "..", "build", "index.js");
const MODERN = "2026-07-28";
const META = {
    "io.modelcontextprotocol/protocolVersion": MODERN,
    "io.modelcontextprotocol/clientInfo": { name: "test", version: "0" },
    "io.modelcontextprotocol/clientCapabilities": {},
};

type Rpc = (method: string, params?: Record<string, unknown>) => Promise<any>;

async function withServer<T>(env: Record<string, string>, run: (rpc: Rpc) => Promise<T>): Promise<T> {
    const dir = mkdtempSync(join(tmpdir(), "omnidim-skills-"));
    const child = spawn("node", [BINARY], {
        env: { ...process.env, HOME: dir, USERPROFILE: dir, OMNIDIM_API_KEY: "sk_test", OMNIDIM_TELEMETRY: "off", ...env },
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
    const rpc: Rpc = (method, params = {}) =>
        new Promise((done) => {
            id += 1;
            waiting.set(id, done);
            child.stdin!.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params: { ...params, _meta: META } })}\n`);
        });
    try {
        return await run(rpc);
    } finally {
        child.kill();
        rmSync(dir, { recursive: true, force: true });
    }
}

describe("skills over MCP on the stdio server", () => {
    it("speaks 2026-07-28 and declares the skills extension", async () => {
        const discover = await withServer({}, (rpc) => rpc("server/discover"));

        expect(discover.result.supportedVersions).toContain(MODERN);
        expect(discover.result.capabilities.extensions).toEqual({ "io.modelcontextprotocol/skills": {} });
    }, 15_000);

    it("lists every served skill with digests that match what resources/read returns", async () => {
        const { list, reads } = await withServer({}, async (rpc) => {
            await rpc("server/discover");
            const list = await rpc("skills/list");
            const uris = list.result.skills.flatMap((s: any) => s.resources.map((r: any) => r.uri));
            const reads = await Promise.all(uris.map((uri: string) => rpc("resources/read", { uri })));
            return { list, reads };
        });

        const names = list.result.skills.map((s: any) => s.frontmatter.name).sort();
        expect(names).toEqual([
            "omnidim-audit-calls",
            "omnidim-build-agent",
            "omnidim-build-workflow",
            "omnidim-onboard-client",
            "omnidim-run-campaign",
        ]);
        const resources = list.result.skills.flatMap((s: any) => s.resources);
        resources.forEach((resource: any, i: number) => {
            const bytes = Buffer.from(reads[i].result.contents[0].text, "utf8");
            expect(bytes.length).toBe(resource.size);
            expect(`sha256:${createHash("sha256").update(bytes).digest("hex")}`).toBe(resource.digest);
        });
        expect(resources.map((r: any) => r.uri)).toContain("skill://omnidim-build-agent/design-agent.md");
    }, 15_000);

    it("gets one skill by uri and refuses one it does not serve", async () => {
        const [found, missing] = await withServer({}, async (rpc) => {
            await rpc("server/discover");
            return Promise.all([
                rpc("skills/get", { uri: "skill://omnidim-run-campaign/SKILL.md" }),
                rpc("skills/get", { uri: "skill://omnidim-connect/SKILL.md" }),
            ]);
        });

        expect(found.result.skill.frontmatter.name).toBe("omnidim-run-campaign");
        expect(missing.error.code).toBe(-32602);
    }, 15_000);

    it("serves only the review skill in read-only mode", async () => {
        const list = await withServer({ OMNIDIM_READONLY: "1" }, async (rpc) => {
            await rpc("server/discover");
            return rpc("skills/list");
        });

        expect(list.result.skills.map((s: any) => s.frontmatter.name)).toEqual(["omnidim-audit-calls"]);
    }, 15_000);
});
