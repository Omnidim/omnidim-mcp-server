import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it, vi } from "vitest";

// Drives one real tool call through the server and reads the request axios was given.
// The backend reads this header to tell MCP traffic from raw API calls.
const h = vi.hoisted(() => {
    process.env.OMNIDIM_API_KEY = "sk_test_user_agent";
    return {
        requests: [] as Array<{ headers: Record<string, string> }>,
        replies: [] as Array<{ id?: number }>,
        transport: undefined as undefined | { onmessage?: (m: unknown) => void },
    };
});

vi.mock("axios", () => {
    const axios = vi.fn(async (config: { headers: Record<string, string> }) => {
        h.requests.push(config);
        return { status: 200, statusText: "OK", data: { bots: [] }, headers: {} };
    });
    return { default: Object.assign(axios, { isAxiosError: () => false }) };
});
vi.mock("@modelcontextprotocol/sdk/server/stdio.js", () => ({
    StdioServerTransport: class {
        onmessage?: (m: unknown) => void;
        async start() { h.transport = this; }
        async send(m: { id?: number }) { h.replies.push(m); }
        async close() {}
    },
}));
vi.mock("../src/helpers.js", async (original) => ({
    ...(await original<typeof import("../src/helpers.js")>()),
    isInteractive: () => false,
}));
vi.mock("../src/telemetry.js", () => ({
    beginSession: vi.fn(), emitSessionCrash: vi.fn(), emitSessionEnd: vi.fn(),
    endSession: vi.fn(), recordToolError: vi.fn(), recordToolResult: vi.fn(),
}));
vi.mock("../src/update_notifier.js", () => ({ notifyUpdates: vi.fn() }));

const pkg = JSON.parse(readFileSync(resolve(__dirname, "../package.json"), "utf8"));

describe("outgoing API requests", () => {
    it("send User-Agent omnidim-mcp-server/<package version>", async () => {
        await import("../src/index.js");
        await vi.waitFor(() => expect(h.transport).toBeDefined());

        h.transport!.onmessage!({
            jsonrpc: "2.0", id: 1, method: "tools/call",
            params: { name: "listAgents", arguments: {} },
        });
        await vi.waitFor(() => expect(h.replies.some((r) => r.id === 1)).toBe(true));

        expect(h.requests).toHaveLength(1);
        expect(h.requests[0].headers["user-agent"]).toBe(`omnidim-mcp-server/${pkg.version}`);
    });
});
