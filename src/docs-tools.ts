// searchDocs and readDoc: answers from the public docs at docs.omnidim.io, no account data.
// Same tools as the hosted server's app/services/docs.py.
import { USER_AGENT } from "./helpers.js";

const DOCS_ORIGIN = "https://docs.omnidim.io";
const MAX_DOC_CHARS = 25_000;
// One segment per path part: letters, digits, dash, underscore, dot (never a bare "." or "..").
const DOC_PATH_RE = /^\/docs(\/(?!\.{1,2}(\/|$))[A-Za-z0-9._-]+)*\/?$/;

const DOCS_TOOLS = [
    {
        name: "searchDocs",
        description:
            "Search the OmniDimension documentation (guides and API reference) at docs.omnidim.io. " +
            "Use it before guessing how a feature, field or error works. Returns up to 8 pages, best first, " +
            "each with title, description and url. Read a page with `readDoc`.\n\n(Tags: Docs)",
        inputSchema: {
            type: "object",
            properties: { query: { type: "string", description: "What to look for, in a few words." } },
            required: ["query"],
        },
    },
    {
        name: "readDoc",
        description:
            "Read one docs.omnidim.io page as Markdown. Pass a `url` from `searchDocs`, or a path that " +
            "starts with /docs/.\n\n(Tags: Docs)",
        inputSchema: {
            type: "object",
            properties: {
                url: {
                    type: "string",
                    description: "A docs.omnidim.io page url or path, e.g. /docs/get-started/quickstart.",
                },
            },
            required: ["url"],
        },
    },
];

const NAMES = new Set(DOCS_TOOLS.map((t) => t.name));

export function isDocsTool(name: string): boolean {
    return NAMES.has(name);
}

export function addDocsTools(map: Map<string, any>): void {
    for (const t of DOCS_TOOLS) {
        map.set(t.name, { ...t, method: "get", pathTemplate: "", executionParameters: [], securityRequirements: [] });
    }
}

// The /docs/ path of a docs.omnidim.io page url or path, or null for anything else.
export function docPath(raw: unknown): string | null {
    if (typeof raw !== "string") return null;
    const trimmed = raw.trim();
    // A full url must be exactly this origin; anything left must then be a /docs/ path.
    const rest = trimmed.startsWith(DOCS_ORIGIN) ? trimmed.slice(DOCS_ORIGIN.length) : trimmed;
    let path: string;
    try {
        path = decodeURIComponent(rest.split(/[?#]/)[0]);
    } catch {
        return null;
    }
    return DOC_PATH_RE.test(path) ? path : null;
}

type Result = { content: Array<{ type: "text"; text: string }>; isError?: boolean };

const ok = (text: string): Result => ({ content: [{ type: "text", text }] });
const fail = (text: string): Result => ({ content: [{ type: "text", text: JSON.stringify({ error: text }) }], isError: true });

function upstreamError(status: number): Result {
    return fail(status === 429 ? "The docs search is busy. Wait a minute, then try again." : `docs.omnidim.io answered ${status}. Try again later.`);
}

async function get(fetchImpl: typeof fetch, url: string, headers: Record<string, string> = {}): Promise<Response> {
    // The user's API key never goes to the docs site: these requests carry no Authorization.
    return fetchImpl(url, { headers: { "User-Agent": USER_AGENT, ...headers }, signal: AbortSignal.timeout(15_000) });
}

export async function callDocsTool(name: string, args: Record<string, unknown>, fetchImpl: typeof fetch = fetch): Promise<Result> {
    try {
        if (name === "searchDocs") {
            const query = typeof args.query === "string" ? args.query.trim().slice(0, 200) : "";
            if (!query) return fail("searchDocs needs a query.");
            // /api/spotlight ranks pages the way the docs site's own search and chat do.
            const res = await get(fetchImpl, `${DOCS_ORIGIN}/api/spotlight?${new URLSearchParams({ q: query })}`);
            if (res.status !== 200) return upstreamError(res.status);
            const hits = (await res.json()) as Array<{ url?: unknown; title?: unknown; description?: unknown }>;
            const pages = hits
                .filter((h) => typeof h?.url === "string" && h.url.startsWith("/"))
                .map((h) => ({ title: h.title, description: h.description, url: DOCS_ORIGIN + h.url }));
            return ok(JSON.stringify({ pages }, null, 2));
        }
        const path = docPath(args.url);
        if (!path) return fail("readDoc reads only https://docs.omnidim.io pages under /docs/.");
        const res = await get(fetchImpl, DOCS_ORIGIN + path, { Accept: "text/markdown" });
        if (res.status === 404) return fail(`No docs page at ${path}.`);
        if (res.status !== 200) return upstreamError(res.status);
        let text = await res.text();
        if (text.length > MAX_DOC_CHARS) text = `${text.slice(0, MAX_DOC_CHARS)}\n\n[Page cut at ${MAX_DOC_CHARS} of ${text.length} chars.]`;
        return ok(text);
    } catch (e) {
        return fail(`docs.omnidim.io could not be reached (${e instanceof Error ? e.name : "error"}). Try again later.`);
    }
}
