import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
    GetPromptRequestSchema,
    ListPromptsRequestSchema,
    ListResourcesRequestSchema,
    ReadResourceRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

import generated from "./playbooks.generated.js";
import { LEGACY_CANVAS_URI, WORKFLOW_CANVAS_HTML, WORKFLOW_CANVAS_URI } from "./workflow-canvas.js";

interface PromptArg { name: string; description: string; required?: boolean; }
interface PlaybookDef { name: string; description: string; arguments: PromptArg[]; text: string; }
interface ResourceDef { uri: string; name: string; description: string; mimeType: string; text: string; }

export const REQUEST_BODY_RULE =
    "On this server every write tool takes its body inside `requestBody`. Path, query and header fields, " +
    "such as `agent_id`, `pageno` and `Idempotency-Key`, stay at the top level. Where this text shows " +
    "`updateAgent` { agent_id, welcome_message }, send `updateAgent` { agent_id, requestBody: { welcome_message } }.";

const PLAYBOOKS: PlaybookDef[] = generated.playbooks;

const RESOURCES: ResourceDef[] = [
    ...generated.guides.map((g) => ({ ...g, text: `${REQUEST_BODY_RULE}\n\n${g.text}` })),
    {
        uri: WORKFLOW_CANVAS_URI,
        name: "Workflow canvas",
        description: "Interactive view of a workflow draft, shown by clients that support MCP Apps.",
        mimeType: "text/html;profile=mcp-app",
        text: WORKFLOW_CANVAS_HTML,
    },
];

function givenBlock(args: Record<string, string>): string {
    const given = Object.entries(args).filter(([, v]) => v);
    if (!given.length) return "";
    const lines = given.map(([k, v]) => `- ${k}: ${v}`).join("\n");
    return `Given by the user (these override any line below that says a value was not given):\n${lines}\n\n`;
}

export function getPromptText(name: string, args: Record<string, string> = {}): string | null {
    const p = PLAYBOOKS.find((x) => x.name === name);
    return p ? `${REQUEST_BODY_RULE}\n\n${givenBlock(args)}${p.text}` : null;
}
function findResource(uri: string): ResourceDef | undefined {
    const current = uri === LEGACY_CANVAS_URI ? WORKFLOW_CANVAS_URI : uri;
    return RESOURCES.find((x) => x.uri === current);
}
export function getResourceText(uri: string): string | null {
    return findResource(uri)?.text ?? null;
}
export const PROMPT_NAMES = PLAYBOOKS.map((p) => p.name);
export const RESOURCE_URIS = RESOURCES.map((r) => r.uri);
export const GUIDE_NAMES = [...PROMPT_NAMES, ...generated.guides.map((g) => g.uri)];
export function listResources(): Omit<ResourceDef, "text">[] {
    return RESOURCES.map(({ uri, name, description, mimeType }) => ({ uri, name, description, mimeType }));
}

const READ_GUIDE_TOOL = {
    name: "readGuide",
    description:
        "Read an OmniDimension playbook or guide: the steps the team follows to design, build, change, " +
        "test and roll back agents, run campaigns, build workflows and review calls. Call it before that " +
        "work and follow its steps.\n\n(Tags: Docs)",
    inputSchema: {
        type: "object",
        properties: { name: { type: "string", enum: GUIDE_NAMES, description: "A playbook name or a guide URI." } },
        required: ["name"],
    },
    annotations: { readOnlyHint: true },
};

export const READ_GUIDE_INSTRUCTION =
    "Before you design, build or change an agent, launch a call campaign, build a workflow, review calls or " +
    "roll an agent back, call `readGuide` with the matching playbook (" + PROMPT_NAMES.join(", ") + ") and " +
    "follow its steps. If you are unsure which tool fits, read `omnidim://guide/routing` with `readGuide`.";

export function isGuideTool(name: string): boolean {
    return name === READ_GUIDE_TOOL.name;
}

export function addGuideTool(map: Map<string, any>): void {
    map.set(READ_GUIDE_TOOL.name, { ...READ_GUIDE_TOOL, method: "get", pathTemplate: "", executionParameters: [], securityRequirements: [] });
}

export function callGuideTool(args: Record<string, unknown>): { content: { type: "text"; text: string }[]; isError?: boolean } {
    const name = String(args.name ?? "");
    const text = getPromptText(name) ?? (GUIDE_NAMES.includes(name) ? getResourceText(name) : null);
    if (text === null) {
        return { content: [{ type: "text", text: `readGuide needs a name from: ${GUIDE_NAMES.join(", ")}` }], isError: true };
    }
    return { content: [{ type: "text", text }] };
}

export function registerProcedures(server: Server): void {
    server.setRequestHandler(ListPromptsRequestSchema, async () => ({
        prompts: PLAYBOOKS.map(({ name, description, arguments: args }) => ({ name, description, arguments: args })),
    }));
    server.setRequestHandler(GetPromptRequestSchema, async (request) => {
        const p = PLAYBOOKS.find((x) => x.name === request.params.name);
        if (!p) throw new Error(`Unknown prompt: ${request.params.name}`);
        const args = (request.params.arguments ?? {}) as Record<string, string>;
        return {
            description: p.description,
            messages: [{ role: "user", content: { type: "text", text: getPromptText(p.name, args) ?? "" } }],
        };
    });
    server.setRequestHandler(ListResourcesRequestSchema, async () => ({
        resources: listResources(),
    }));
    server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
        const r = findResource(request.params.uri);
        if (!r) throw new Error(`Unknown resource: ${request.params.uri}`);
        return { contents: [{ uri: request.params.uri, mimeType: r.mimeType, text: r.text }] };
    });
}
