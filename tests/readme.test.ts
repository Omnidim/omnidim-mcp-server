import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

// The README tools table is the first thing a visitor and a directory reviewer read,
// and it went stale before (it listed excluded reseller tools and missed workflows).
const toolSources = ["index.ts", "workflow-canvas.ts", "docs-tools.ts"].map((f) =>
    readFileSync(resolve(__dirname, "../src", f), "utf8"),
);
const readme = readFileSync(resolve(__dirname, "../README.md"), "utf8");

const servedTools = toolSources
    .flatMap((s) => [...s.matchAll(/^\s+name: "([A-Za-z]+)",$/gm)].map((m) => m[1]))
    .sort();
const toolsSection = readme.split(/^## /m).find((s) => s.startsWith("Tools")) ?? "";
const listedTools = [...toolsSection.matchAll(/`([a-z][A-Za-z]+)`/g)].map((m) => m[1]).sort();

const areaCounts = [...toolsSection.matchAll(/^\| [^|]+ \| [^|]+ \| (\d+) \|$/gm)].map((m) => Number(m[1]));

describe("README tools table", () => {
    it("lists exactly the tools the server serves", () => {
        expect(servedTools.length).toBeGreaterThan(0);
        expect(listedTools).toEqual(servedTools);
    });

    it("has area counts that add up to the tools served", () => {
        expect(areaCounts.length).toBeGreaterThan(0);
        expect(areaCounts.reduce((a, b) => a + b, 0)).toBe(servedTools.length);
    });
});
