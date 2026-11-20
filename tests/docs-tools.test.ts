import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { addDocsTools, callDocsTool, docPath } from "../src/docs-tools.js";
import { toolAnnotations } from "../src/tool-annotations.js";

type Seen = { url: string; headers: Record<string, string> };

function fakeFetch(status: number, body: string, seen: Seen[] = []): typeof fetch {
    return (async (input: string | URL, init?: RequestInit) => {
        seen.push({ url: String(input), headers: Object.fromEntries(new Headers(init?.headers).entries()) });
        return new Response(body, { status });
    }) as typeof fetch;
}

const text = (r: { content: Array<{ type: string; text?: string }> }) => r.content[0].text ?? "";

describe("docs tools", () => {
    it("are added to the tool map and marked read-only", () => {
        const map = new Map<string, any>();
        addDocsTools(map);
        expect([...map.keys()].sort()).toEqual(["readDoc", "searchDocs"]);
        for (const name of map.keys()) {
            const a = toolAnnotations({ name, method: "get" });
            expect(a.readOnlyHint).toBe(true);
            expect(a.openWorldHint).toBe(false);
        }
    });

    it("searchDocs returns ranked pages with full urls and sends no credentials", async () => {
        const seen: Seen[] = [];
        const hits = [{ url: "/docs/bulk-calls/overview", title: "Bulk Call Campaign Guide", description: "d", kind: "guide" }];
        const r = await callDocsTool("searchDocs", { query: "bulk call concurrency" }, fakeFetch(200, JSON.stringify(hits), seen));
        expect(r.isError).toBeFalsy();
        expect(JSON.parse(text(r)).pages[0].url).toBe("https://docs.omnidim.io/docs/bulk-calls/overview");
        const url = new URL(seen[0].url);
        expect(url.host).toBe("docs.omnidim.io");
        expect(url.searchParams.get("q")).toBe("bulk call concurrency");
        expect(seen[0].headers.authorization).toBeUndefined();
    });

    it("searchDocs needs a query", async () => {
        const seen: Seen[] = [];
        const r = await callDocsTool("searchDocs", { query: " " }, fakeFetch(200, "[]", seen));
        expect(r.isError).toBe(true);
        expect(seen).toHaveLength(0);
    });

    it("searchDocs tells the agent to wait when the docs site is busy", async () => {
        const r = await callDocsTool("searchDocs", { query: "webhook" }, fakeFetch(429, "{}"));
        expect(r.isError).toBe(true);
        expect(text(r)).toMatch(/try again/);
    });

    it("readDoc fetches the page as Markdown", async () => {
        const seen: Seen[] = [];
        const r = await callDocsTool(
            "readDoc",
            { url: "https://docs.omnidim.io/docs/get-started/quickstart" },
            fakeFetch(200, "# Quickstart\n\nSteps.", seen),
        );
        expect(text(r)).toMatch(/^# Quickstart/);
        expect(new URL(seen[0].url).pathname).toBe("/docs/get-started/quickstart");
        expect(seen[0].headers.accept).toBe("text/markdown");
        expect(seen[0].headers.authorization).toBeUndefined();
    });

    it.each([
        "https://evil.example/docs/x",
        "/api/chat",
        "/docs/../api/chat",
        "/docs/%2e%2e/api/chat",
        "//evil.example/docs/x",
        "http://docs.omnidim.io/docs/x",
        "https://docs.omnidim.io.evil.example/docs/x",
    ])("readDoc refuses %s without a request", async (url) => {
        expect(docPath(url)).toBeNull();
        const seen: Seen[] = [];
        const r = await callDocsTool("readDoc", { url }, fakeFetch(200, "x", seen));
        expect(r.isError).toBe(true);
        expect(seen).toHaveLength(0);
    });

    // index.ts is generated: these guard the regen patches that serve and route the docs tools.
    it("are served and routed by the generated server", () => {
        const src = readFileSync(resolve(__dirname, "..", "src", "index.ts"), "utf8");
        expect(src).toContain("addDocsTools(toolDefinitionMap);");
        const call = src.slice(src.indexOf("server.setRequestHandler(CallToolRequestSchema"));
        expect(call.indexOf("if (isDocsTool(toolName)) return await callDocsTool(")).toBeGreaterThan(-1);
        expect(call.indexOf("if (isDocsTool(toolName))")).toBeLessThan(call.indexOf("executeApiTool("));
    });
});
