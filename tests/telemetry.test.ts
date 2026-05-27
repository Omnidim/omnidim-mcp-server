import { describe, expect, it } from "vitest";

import { endSession, recordToolResult, sanitizeError } from "../src/telemetry.js";

describe("sanitizeError", () => {
    it("keeps the errno code and class but never the message", () => {
        const e = Object.assign(
            new Error("ENOENT: no such file, open '/Users/alice/secret.json'"),
            { code: "ENOENT" },
        );
        expect(sanitizeError(e)).toEqual({ error_class: "Error", error_code: "ENOENT" });
    });

    it("keeps the constructor name as error_class", () => {
        expect(sanitizeError(new TypeError("boom"))).toEqual({
            error_class: "TypeError",
            error_code: "unknown",
        });
    });

    it("drops a code that is not errno-shaped", () => {
        const e = Object.assign(new Error("x"), { code: 500 });
        expect(sanitizeError(e).error_code).toBe("unknown");
    });

    it("rejects a name that could carry a path or PII", () => {
        const e = Object.assign(new Error("x"), { name: "/Users/alice failed" });
        expect(sanitizeError(e).error_class).toBe("Error");
    });

    it("handles non-object throws", () => {
        expect(sanitizeError("boom")).toEqual({ error_class: "Error", error_code: "unknown" });
        expect(sanitizeError(undefined)).toEqual({ error_class: "Error", error_code: "unknown" });
    });
});

describe("recordToolResult + endSession", () => {
    it("aggregates ok and error counts per tool and totals errors", () => {
        recordToolResult("listAgents", "ok");
        recordToolResult("listAgents", "ok");
        recordToolResult("listAgents", "http_500");
        recordToolResult("dispatchCall", "http_401");

        const summary = endSession();
        const byTool = Object.fromEntries(summary.tools_called.map((t) => [t.tool, t]));

        expect(byTool.listAgents.count).toBe(3);
        expect(byTool.listAgents.ok).toBe(2);
        expect(byTool.listAgents.errors).toEqual([{ code: "http_500", count: 1 }]);
        expect(byTool.dispatchCall.errors).toEqual([{ code: "http_401", count: 1 }]);
        expect(summary.tool_errors_total).toBe(2);
    });

    it("drains state so a second endSession is empty", () => {
        recordToolResult("x", "ok");
        endSession();
        expect(endSession()).toEqual({ duration_s: 0, tools_called: [], tool_errors_total: 0 });
    });
});
