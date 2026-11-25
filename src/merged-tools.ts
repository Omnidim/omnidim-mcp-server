import { flatInputSchema } from "./flat-args.js";
import { MERGE_GROUPS, MERGE_MEMBERS, type MergeGroup, type MergeMember } from "./tool-merges.js";

type Schema = Record<string, any>;

interface ToolDef {
    name: string;
    description: string;
    inputSchema: Schema;
    method: string;
    pathTemplate: string;
    executionParameters: { name: string; in: string }[];
    securityRequirements: any[];
    [key: string]: unknown;
}

interface Route {
    def: ToolDef;
    inputs: string[];
    required: string[];
    sendsField: boolean;
}

export interface MergedTool extends ToolDef {
    field: string;
    routes: Record<string, Route>;
}

export function isMergedTool(def: unknown): def is MergedTool {
    return typeof def === "object" && def !== null && "routes" in def;
}

function canonical(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(canonical);
    if (value && typeof value === "object") {
        return Object.fromEntries(Object.keys(value).sort().map((k) => [k, canonical((value as Schema)[k])]));
    }
    return value;
}

const withoutDescription = ({ description: _said, ...rest }: Schema) => JSON.stringify(canonical(rest));
const withoutTags = (description: string) => description.replace(/\n\(Tags: [^)]*\)\s*$/, "").trim();

function mergedTool(name: string, group: MergeGroup, defs: [ToolDef, MergeMember][]): MergedTool {
    const { field } = group;
    const routes: Record<string, Route> = {};
    const props: Schema = {};
    const takers: Record<string, string[]> = {};
    const sections: string[] = [];
    for (const [def, member] of defs) {
        const flat = flatInputSchema(def);
        const own: Schema = flat.properties ?? {};
        const inputs = Object.keys(own).filter((k) => !(member.passes && k === field));
        for (const key of inputs) {
            if (key in props && withoutDescription(props[key]) !== withoutDescription(own[key])) {
                throw new Error(`${name}: input ${key} differs between its actions`);
            }
            props[key] ??= own[key];
            (takers[key] ??= []).push(...member.actions);
        }
        const required = ((flat.required ?? []) as string[]).filter((r) => inputs.includes(r)).sort();
        for (const action of member.actions) routes[action] = { def, inputs, required, sendsField: member.passes };
        sections.push(`\`${member.actions.join("`, `")}\`: ${withoutTags(def.description)}`);
    }
    const every = Object.keys(routes);
    for (const [key, acts] of Object.entries(takers)) {
        if (new Set(acts).size < every.length) {
            const only = acts.map((a) => `\`${a}\``).join(", ");
            props[key] = { ...props[key], description: `Only for ${only}. ${props[key].description ?? ""}`.trim() };
        }
    }
    const required = Object.keys(props).filter((k) => Object.values(routes).every((r) => r.required.includes(k)));
    return {
        name,
        description: `${group.description}\n\nSet \`${field}\` to pick what to do.\n\n${sections.join("\n\n")}`,
        inputSchema: {
            type: "object",
            properties: {
                [field]: { type: "string", enum: every, description: `What to do: ${every.join(", ")}.` },
                ...props,
            },
            required: [field, ...required.sort()],
        },
        method: defs[0][0].method,
        pathTemplate: defs[0][0].pathTemplate,
        executionParameters: [],
        securityRequirements: defs[0][0].securityRequirements,
        field,
        routes,
    };
}

export function foldMergedTools(
    map: Map<string, any>,
    groups: Record<string, MergeGroup> = MERGE_GROUPS,
    members: Record<string, MergeMember> = MERGE_MEMBERS,
): void {
    const byTool: Record<string, [ToolDef, MergeMember][]> = {};
    for (const [opId, member] of Object.entries(members)) {
        const def = map.get(opId);
        if (def) (byTool[member.tool] ??= []).push([def, member]);
    }
    const folded = new Map<string, string>();
    for (const [name, defs] of Object.entries(byTool)) {
        const tool = mergedTool(name, groups[name], defs);
        for (const [def, member] of defs) {
            map.delete(def.name);
            if (def.name !== name) folded.set(def.name, `\`${name}\` with \`${tool.field}\` \`${member.actions[0]}\``);
        }
        map.set(name, tool);
    }
    for (const def of map.values()) {
        def.description = def.description.replace(/`(\w+)`/g, (said: string, op: string) => folded.get(op) ?? said);
    }
}

export function pickMergedAction(
    tool: MergedTool,
    args: Record<string, unknown>,
): { def: ToolDef; args: Record<string, unknown> } | { error: string } {
    const action = args[tool.field];
    const route = typeof action === "string" ? tool.routes[action] : undefined;
    if (!route) return { error: `${tool.field} must be one of: ${Object.keys(tool.routes).join(", ")}` };
    const others = new Set(
        Object.keys(tool.inputSchema.properties)
            .filter((k) => !route.inputs.includes(k) && !(route.sendsField && k === tool.field))
            .map((k) => k.toLowerCase()),
    );
    const kept = Object.fromEntries(Object.entries(args).filter(([k]) => !others.has(k.toLowerCase())));
    const missing = route.required.filter((r) => !(r in kept));
    if (missing.length) return { error: `${tool.field} ${action} needs: ${missing.join(", ")}` };
    return { def: route.def, args: kept };
}

export function unknownToolMessage(
    name: string,
    members: Record<string, MergeMember> = MERGE_MEMBERS,
    groups: Record<string, MergeGroup> = MERGE_GROUPS,
): string {
    const member = members[name];
    if (!member || member.tool === name) return `Unknown tool requested: ${name}`;
    return `Unknown tool requested: ${name}. Call ${member.tool} with ${groups[member.tool].field} ${member.actions[0]}.`;
}
