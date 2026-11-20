import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { keepReadOnlyTools, readOnlyMode, toolAnnotations } from "../src/tool-annotations.js";

describe("read-only mode", () => {
    it("turns on only for an explicit yes", () => {
        for (const v of ["1", "true", "on", "yes", "TRUE"]) expect(readOnlyMode({ OMNIDIM_READONLY: v })).toBe(true);
        for (const v of [undefined, "", "0", "false", "off", "no"]) expect(readOnlyMode({ OMNIDIM_READONLY: v })).toBe(false);
    });

    it("keeps only tools marked read-only", () => {
        const map = new Map(
            ["listAgents", "getCallLog", "createAgent", "deleteAgent", "dispatchCall", "showWorkflow"].map((name) => [
                name,
                { name, method: "get" },
            ]),
        );
        keepReadOnlyTools(map);
        expect([...map.keys()].sort()).toEqual(["getCallLog", "listAgents", "showWorkflow"]);
        for (const name of map.keys()) expect(toolAnnotations({ name, method: "get" }).readOnlyHint).toBe(true);
    });

    // index.ts is generated: this guards the regen patch that applies the filter before tools are served.
    it("is applied to the served tool map", () => {
        const src = readFileSync(resolve(__dirname, "..", "src", "index.ts"), "utf8");
        const filter = src.indexOf("if (readOnlyMode()) keepReadOnlyTools(toolDefinitionMap);");
        expect(filter).toBeGreaterThan(src.indexOf("addShowWorkflow(toolDefinitionMap);"));
        expect(filter).toBeLessThan(src.indexOf("server.setRequestHandler(ListToolsRequestSchema"));
    });
});
