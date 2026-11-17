import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { buildToolSchema } from "../src/tool-schema.js";

const schemas: any[] = readFileSync(new URL("../src/index.ts", import.meta.url), "utf8")
    .split(/\r?\n/) // Windows checkouts have CRLF line endings
    .filter((line) => line.startsWith("    inputSchema: {"))
    .map((line) => JSON.parse(line.slice("    inputSchema: ".length).replace(/,$/, "")));

// A tool whose schema fails to build used to fall back to "accept anything",
// which silently turned off argument checks (dispatchCall and createSession did).
describe("tool input schemas", () => {
    it("finds the generated tool schemas", () => {
        expect(schemas.length).toBeGreaterThan(50);
    });

    it("rejects an empty call for every tool with a required argument", () => {
        const withRequired = schemas.filter((s) => (s.required ?? []).length > 0);
        expect(withRequired.length).toBeGreaterThan(0);
        const accepted = withRequired.flatMap((s, i) =>
            buildToolSchema(s).safeParse({}).success ? [`#${i} ${s.required.join(",")}`] : [],
        );
        expect(accepted).toEqual([]);
    });

    it("rejects a wrong type inside a oneOf schema", () => {
        const schema = buildToolSchema({
            type: "object",
            required: ["agent_id"],
            properties: {
                agent_id: { type: "number" },
                languages: { oneOf: [{ type: "array", items: { type: "string" } }, { type: "string" }] },
            },
        });
        expect(schema.safeParse({ agent_id: 1, languages: "Hindi|English" }).success).toBe(true);
        expect(schema.safeParse({ agent_id: 1, languages: 5 }).success).toBe(false);
        expect(schema.safeParse({ agent_id: "1" }).success).toBe(false);
    });

    it("drops unknown keys on generated schemas", () => {
        const schema = buildToolSchema({ type: "object", properties: { name: { type: "string" } } });
        expect(schema.parse({ name: "a", extra: 1 })).toEqual({ name: "a" });
    });
});
