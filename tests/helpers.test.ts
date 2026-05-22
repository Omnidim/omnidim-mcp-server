import { describe, expect, it } from "vitest";

import {
    LIST_KEYS,
    MAX_LIST_CHARS,
    findList,
    redactSensitive,
    trimLargeResponse,
} from "../src/helpers.js";

describe("redactSensitive", () => {
    it("replaces api_key field values with [redacted]", () => {
        const result = redactSensitive({ id: 1, api_key: "sk_live_abc" });
        expect(result).toEqual({ id: 1, api_key: "[redacted]" });
    });

    it("recurses into nested objects", () => {
        const input = {
            user: { email: "x@y.com", api_keys: [{ id: 1, api_key: "secret" }] },
        };
        const result = redactSensitive(input);
        expect(result).toEqual({
            user: { email: "x@y.com", api_keys: [{ id: 1, api_key: "[redacted]" }] },
        });
    });

    it("preserves non-sensitive fields untouched", () => {
        const input = { name: "Agent", phone: "+15551234567", api_keys: [] };
        expect(redactSensitive(input)).toEqual(input);
    });

    it("returns primitives unchanged", () => {
        expect(redactSensitive("hello")).toBe("hello");
        expect(redactSensitive(42)).toBe(42);
        expect(redactSensitive(null)).toBe(null);
        expect(redactSensitive(undefined)).toBe(undefined);
        expect(redactSensitive(true)).toBe(true);
    });

    it("only redacts the exact key 'api_key', not similar names", () => {
        const input = { apiKey: "kept", api_keys: ["kept"], api_key_id: "kept" };
        expect(redactSensitive(input)).toEqual(input);
    });

    it("handles deeply nested redaction in reseller-shaped payloads", () => {
        const input = {
            organizations: [
                {
                    id: 1,
                    users: [
                        { id: 10, api_keys: [{ api_key: "sk_1" }, { api_key: "sk_2" }] },
                    ],
                },
            ],
        };
        const result = redactSensitive(input) as typeof input;
        expect(result.organizations[0].users[0].api_keys[0].api_key).toBe("[redacted]");
        expect(result.organizations[0].users[0].api_keys[1].api_key).toBe("[redacted]");
    });
});

describe("findList", () => {
    it("returns the array directly when input is an array", () => {
        const arr = [1, 2, 3];
        expect(findList(arr)).toEqual({ arr, key: null });
    });

    it("finds known list keys", () => {
        for (const key of LIST_KEYS) {
            const result = findList({ [key]: [{ id: 1 }] });
            expect(result?.key).toBe(key);
            expect(result?.arr).toEqual([{ id: 1 }]);
        }
    });

    it("returns null for objects without a list key", () => {
        expect(findList({ id: 1, name: "x" })).toBeNull();
    });

    it("returns null for primitives", () => {
        expect(findList(null)).toBeNull();
        expect(findList(42)).toBeNull();
        expect(findList("hello")).toBeNull();
    });

    it("returns the first matching key when multiple exist", () => {
        const result = findList({ data: [1], items: [2] });
        expect(result?.key).toBe("data");
    });
});

describe("trimLargeResponse", () => {
    it("passes small payloads through unchanged", () => {
        const result = trimLargeResponse({ id: 1, name: "agent" });
        expect(result.note).toBeUndefined();
        expect(JSON.parse(result.text)).toEqual({ id: 1, name: "agent" });
    });

    it("does not trim large single-resource responses", () => {
        const huge = { id: 1, prompt: "x".repeat(MAX_LIST_CHARS + 1000) };
        const result = trimLargeResponse(huge);
        expect(result.note).toBeUndefined();
        expect(result.text.length).toBeGreaterThan(MAX_LIST_CHARS);
    });

    it("trims oversize list responses and includes a hint", () => {
        const items = Array.from({ length: 200 }, (_, i) => ({
            id: i,
            body: "filler".repeat(200),
        }));
        const result = trimLargeResponse({ bots: items });
        expect(result.note).toBeDefined();
        expect(result.note).toMatch(/Showing \d+ of 200 items/);
        expect(result.text.length).toBeLessThanOrEqual(MAX_LIST_CHARS);
    });

    it("keeps the wrapping object structure when trimming a nested list", () => {
        const items = Array.from({ length: 200 }, (_, i) => ({ id: i, body: "x".repeat(500) }));
        const result = trimLargeResponse({ bots: items, total_records: 200 });
        const parsed = JSON.parse(result.text);
        expect(parsed.total_records).toBe(200);
        expect(parsed.bots.length).toBeLessThan(200);
    });

    it("redacts api_key fields even when trimming is not needed", () => {
        const result = trimLargeResponse({
            users: [{ id: 1, api_keys: [{ api_key: "sk_secret" }] }],
        });
        expect(result.text).not.toContain("sk_secret");
        expect(result.text).toContain("[redacted]");
    });

    it("redacts api_key fields inside trimmed list items", () => {
        const items = Array.from({ length: 50 }, (_, i) => ({
            id: i,
            api_key: `sk_secret_${i}`,
            filler: "x".repeat(2000),
        }));
        const result = trimLargeResponse({ data: items });
        expect(result.text).toContain("[redacted]");
        expect(result.text).not.toMatch(/sk_secret_\d/);
    });

    it("falls back to a hard truncation when even one item exceeds the budget", () => {
        const oneHuge = [{ id: 1, body: "x".repeat(MAX_LIST_CHARS * 2) }];
        const result = trimLargeResponse(oneHuge);
        expect(result.note).toBeDefined();
        expect(result.text.length).toBeLessThanOrEqual(MAX_LIST_CHARS);
    });
});
