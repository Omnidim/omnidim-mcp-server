import { ProtocolError, ProtocolErrorCode, type Server } from "@modelcontextprotocol/server";
import { SKILLS_EXTENSION_ID, SKILLS_GET_METHOD, SKILLS_LIST_METHOD, skillEntry, type Skill } from "@modelcontextprotocol/server/ext/skills";
import { z } from "zod";

import generated from "./playbooks.generated.js";
import { readOnlyMode } from "./tool-annotations.js";
import { LEGACY_CANVAS_URI, WORKFLOW_CANVAS_HTML, WORKFLOW_CANVAS_URI } from "./workflow-canvas.js";

interface PromptArg { name: string; description: string; required?: boolean; }
interface Variant { given: string[]; text: string; }
interface PlaybookDef { name: string; description: string; arguments: PromptArg[]; variants: Variant[]; }
interface ResourceDef { uri: string; name: string; description: string; mimeType: string; text: string; }

const PLAYBOOKS: PlaybookDef[] = generated.playbooks;

const RESOURCES: ResourceDef[] = [
    ...generated.guides,
    {
        uri: WORKFLOW_CANVAS_URI,
        name: "Workflow canvas",
        description: "Interactive view of a workflow draft, shown by clients that support MCP Apps.",
        mimeType: "text/html;profile=mcp-app",
        text: WORKFLOW_CANVAS_HTML,
    },
];

export function getPromptText(name: string, args: Record<string, string> = {}): string | null {
    const p = PLAYBOOKS.find((x) => x.name === name);
    if (!p) return null;
    const given = p.arguments.map((a) => a.name).filter((a) => args[a]).sort();
    const variant = p.variants.find((v) => v.given.join() === given.join());
    if (!variant) return null;
    return given.reduce((text, a) => text.replaceAll(`\u27e6${a}\u27e7`, () => args[a]), variant.text);
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

interface SkillDef { name: string; readOnly: boolean; files: { path: string; text: string }[]; }

const SKILLS: SkillDef[] = generated.skills.filter((s) => s.readOnly || !readOnlyMode());
const SKILL_FILES = new Map<string, string>(
    SKILLS.flatMap((s) => s.files.map((f) => [`skill://${s.name}/${f.path}`, f.text] as const)),
);
const SKILLS_CACHE = { ttlMs: 3_600_000, cacheScope: "public" } as const;
let skillEntries: Promise<Skill[]> | undefined;
function listSkills(): Promise<Skill[]> {
    skillEntries ??= Promise.all(
        SKILLS.map((s) => skillEntry(s.name, Object.fromEntries(s.files.map((f) => [f.path, f.text])))),
    );
    return skillEntries;
}

export function registerProcedures(server: Server): void {
    server.registerCapabilities({ extensions: { [SKILLS_EXTENSION_ID]: {} } });
    server.setRequestHandler("prompts/list", async () => ({
        prompts: PLAYBOOKS.map(({ name, description, arguments: args }) => ({ name, description, arguments: args })),
    }));
    server.setRequestHandler("prompts/get", async (request) => {
        const p = PLAYBOOKS.find((x) => x.name === request.params.name);
        if (!p) throw new ProtocolError(ProtocolErrorCode.InvalidParams, `Unknown prompt: ${request.params.name}`);
        const args = (request.params.arguments ?? {}) as Record<string, string>;
        return {
            description: p.description,
            messages: [{ role: "user", content: { type: "text", text: getPromptText(p.name, args) ?? "" } }],
        };
    });
    server.setRequestHandler("resources/list", async () => ({
        resources: listResources(),
    }));
    server.setRequestHandler("resources/read", async (request) => {
        const { uri } = request.params;
        const skillText = SKILL_FILES.get(uri);
        if (skillText !== undefined) return { contents: [{ uri, mimeType: "text/markdown", text: skillText }] };
        const r = findResource(uri);
        if (!r) throw new ProtocolError(ProtocolErrorCode.InvalidParams, `Unknown resource: ${uri}`);
        return { contents: [{ uri, mimeType: r.mimeType, text: r.text }] };
    });
    server.setRequestHandler(
        SKILLS_LIST_METHOD,
        { params: z.looseObject({ cursor: z.string().optional() }).optional() },
        async (params) => {
            if (params?.cursor !== undefined) throw new ProtocolError(ProtocolErrorCode.InvalidParams, "Unknown cursor");
            return { skills: await listSkills(), ...SKILLS_CACHE };
        },
    );
    server.setRequestHandler(SKILLS_GET_METHOD, { params: z.looseObject({ uri: z.string() }) }, async ({ uri }) => {
        const skill = (await listSkills()).find((s) => s.uri === uri);
        if (!skill) throw new ProtocolError(ProtocolErrorCode.InvalidParams, `No skill is served at ${uri}`);
        return { skill, ...SKILLS_CACHE };
    });
}
