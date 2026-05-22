export const MAX_LIST_CHARS = 25000;

export const LIST_KEYS = [
    "bots",
    "call_log_data",
    "records",
    "files",
    "phone_numbers",
    "llms",
    "voices",
    "stt",
    "tts",
    "services",
    "organizations",
    "data",
    "results",
    "items",
];

// Reseller list endpoints return child orgs' plaintext api_key values.
// Strip them before they reach the model.
export function redactSensitive(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(redactSensitive);
    if (value && typeof value === "object") {
        const out: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(value)) {
            out[k] = k === "api_key" ? "[redacted]" : redactSensitive(v);
        }
        return out;
    }
    return value;
}

export function findList(data: unknown): { arr: unknown[]; key: string | null } | null {
    if (Array.isArray(data)) return { arr: data, key: null };
    if (!data || typeof data !== "object") return null;
    const obj = data as Record<string, unknown>;
    for (const k of LIST_KEYS) {
        const candidate = obj[k];
        if (Array.isArray(candidate)) return { arr: candidate, key: k };
    }
    return null;
}

// Trim list responses to fit a model context budget. Single-resource
// responses are never trimmed; an oversized payload from getAgent etc.
// is handled by the MCP client (spill-to-file + chunked read).
export function trimLargeResponse(data: unknown): { text: string; note?: string } {
    const redacted = redactSensitive(data);
    const full = JSON.stringify(redacted, null, 2);
    const list = findList(redacted);

    if (!list || full.length <= MAX_LIST_CHARS) return { text: full };

    const { arr, key } = list;
    let kept = arr.length;
    while (kept > 1) {
        const trimmed = arr.slice(0, kept);
        const candidate = key
            ? JSON.stringify({ ...(redacted as Record<string, unknown>), [key]: trimmed }, null, 2)
            : JSON.stringify(trimmed, null, 2);
        if (candidate.length <= MAX_LIST_CHARS) {
            return {
                text: candidate,
                note: `[Showing ${kept} of ${arr.length} items. Lower pagesize, filter by name, or fetch a specific item by ID for full detail.]`,
            };
        }
        kept = Math.max(1, Math.floor(kept * 0.6));
    }

    return {
        text: full.slice(0, MAX_LIST_CHARS),
        note: `[Response truncated. Full size: ${full.length} chars.]`,
    };
}
