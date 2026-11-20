import { describe, expect, it } from "vitest";

import {
    LIST_KEYS,
    MAX_LIST_CHARS,
    classifyToolError,
    findList,
    redactSensitive,
    requestIdNote,
    trimLargeResponse,
} from "../src/helpers.js";

describe("classifyToolError", () => {
    it("maps known HTTP statuses to their own code", () => {
        expect(classifyToolError({ isAxiosError: true, response: { status: 401 } })).toBe("http_401");
        expect(classifyToolError({ isAxiosError: true, response: { status: 404 } })).toBe("http_404");
        expect(classifyToolError({ isAxiosError: true, response: { status: 500 } })).toBe("http_500");
    });

    it("buckets uncommon statuses by class", () => {
        expect(classifyToolError({ isAxiosError: true, response: { status: 418 } })).toBe("http_4xx");
        expect(classifyToolError({ isAxiosError: true, response: { status: 504 } })).toBe("http_5xx");
    });

    it("separates timeout from generic network errors", () => {
        expect(classifyToolError({ isAxiosError: true, code: "ECONNABORTED" })).toBe("timeout");
        expect(classifyToolError({ isAxiosError: true, code: "ECONNREFUSED" })).toBe("network");
    });

    it("recognizes zod validation and falls back to unknown", () => {
        expect(classifyToolError({ name: "ZodError" })).toBe("validation");
        expect(classifyToolError(new Error("boom"))).toBe("unknown");
    });
});

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

    // A 20-turn call log measured 38,015 chars, 26,295 of them `interactions` (2026-11-20).
    const callLog = (id: number, turns = 20) => ({
        id,
        call_conversation: "user: hello\nbot: hi there\n".repeat(60),
        recording_url: `https://example.com/rec/${id}.mp3`,
        call_cost: 0.42,
        interactions: Array.from({ length: turns }, (_, t) => ({
            interaction_sequence: t,
            user_query: "q".repeat(300),
            bot_response: "r".repeat(900),
        })),
    });

    it("keeps one large call log as valid JSON with transcript, recording and cost", () => {
        const payload = { call_log_data: [callLog(1)], total_records: 1 };
        expect(JSON.stringify(payload, null, 2).length).toBeGreaterThan(MAX_LIST_CHARS);
        const result = trimLargeResponse(payload);
        const row = JSON.parse(result.text).call_log_data[0];
        expect(row.call_conversation).toBe(payload.call_log_data[0].call_conversation);
        expect(row.recording_url).toBe("https://example.com/rec/1.mp3");
        expect(row.call_cost).toBe(0.42);
        expect(row.interactions).toBeUndefined();
        expect(result.note).toMatch(/interactions/);
    });

    it("drops turn detail from a page of call logs before dropping rows", () => {
        const result = trimLargeResponse({ call_log_data: Array.from({ length: 10 }, (_, i) => callLog(i)) });
        const rows = JSON.parse(result.text).call_log_data;
        expect(rows).toHaveLength(10);
        expect(rows.every((r: Record<string, unknown>) => !("interactions" in r))).toBe(true);
    });

    it("keeps turn detail when the call log fits", () => {
        const result = trimLargeResponse({ call_log_data: [callLog(1, 2)] });
        expect(JSON.parse(result.text).call_log_data[0].interactions).toHaveLength(2);
    });

    it("falls back to a hard truncation when even one item exceeds the budget", () => {
        const oneHuge = [{ id: 1, body: "x".repeat(MAX_LIST_CHARS * 2) }];
        const result = trimLargeResponse(oneHuge);
        expect(result.note).toBeDefined();
        expect(result.text.length).toBeLessThanOrEqual(MAX_LIST_CHARS);
    });
});

describe("requestIdNote", () => {
    it("names the server's request id so a user can quote it to support", () => {
        expect(requestIdNote({ "x-request-id": "4bf92f3577b34da6a3ce929d0e0e4736" }))
            .toBe(" Request id: 4bf92f3577b34da6a3ce929d0e0e4736.");
    });

    it("reads axios header objects, whatever the case of the name", () => {
        const headers = { get: (name: string) => (name.toLowerCase() === "x-request-id" ? "abc123" : undefined) };
        expect(requestIdNote(headers)).toBe(" Request id: abc123.");
    });

    it("adds nothing when the server sent no id", () => {
        expect(requestIdNote({})).toBe("");
        expect(requestIdNote(undefined)).toBe("");
    });
});
