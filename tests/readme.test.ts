import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

// The README tools table is the first thing a visitor and a directory reviewer read,
// and it went stale before (it listed excluded reseller tools and missed workflows).
const src = readFileSync(resolve(__dirname, "../src/index.ts"), "utf8");
const readme = readFileSync(resolve(__dirname, "../README.md"), "utf8");

const servedTools = [...src.matchAll(/^ {4}name: "([A-Za-z]+)",$/gm)].map((m) => m[1]).sort();
const toolsSection = readme.split(/^## /m).find((s) => s.startsWith("Tools")) ?? "";
const listedTools = [...toolsSection.matchAll(/`([a-z][A-Za-z]+)`/g)].map((m) => m[1]).sort();

describe("README tools table", () => {
    it("lists exactly the tools the server serves", () => {
        expect(servedTools.length).toBeGreaterThan(0);
        expect(listedTools).toEqual(servedTools);
    });
});
