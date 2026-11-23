type Schema = Record<string, any>;

interface ToolShape {
    inputSchema: Schema;
    executionParameters: { name: string; in: string }[];
}

function mergeAllOf(schema: Schema): Schema {
    if (!Array.isArray(schema?.allOf)) return schema;
    const { allOf, ...rest } = schema;
    const merged: Schema = { ...rest, type: "object", properties: { ...rest.properties } };
    const required = new Set<string>(rest.required ?? []);
    for (const member of allOf.map(mergeAllOf)) {
        Object.assign(merged.properties, member.properties ?? {});
        for (const r of member.required ?? []) required.add(r);
        merged.description ??= member.description;
    }
    if (required.size) merged.required = [...required];
    return merged;
}

function bodySchema(def: ToolShape): Schema | null {
    const props = def.inputSchema?.properties ?? {};
    if (!props.requestBody) return null;
    const body = mergeAllOf(props.requestBody);
    if (body.type !== "object" || !body.properties) return null;
    const top = Object.keys(props).filter((k) => k !== "requestBody");
    if (Object.keys(body.properties).some((k) => top.includes(k))) return null;
    return body;
}

type ObjectSchema = { type: "object"; [key: string]: any };

export function flatInputSchema(def: ToolShape): ObjectSchema {
    const body = bodySchema(def);
    if (!body) return def.inputSchema as ObjectSchema;
    const { requestBody: _nested, ...top } = def.inputSchema.properties;
    const outer: string[] = def.inputSchema.required ?? [];
    const required = [
        ...outer.filter((r) => r !== "requestBody"),
        ...(outer.includes("requestBody") ? body.required ?? [] : []),
    ];
    const flat: Schema = { ...def.inputSchema, properties: { ...top, ...body.properties } };
    if (required.length) flat.required = required;
    else delete flat.required;
    return flat as ObjectSchema;
}

export function nestBodyArgs(def: ToolShape, args: Record<string, unknown>): Record<string, unknown> {
    if ("requestBody" in args || !bodySchema(def)) return args;
    const routed = new Set(def.executionParameters.map((p) => p.name.toLowerCase()));
    const outer: Record<string, unknown> = {};
    const body: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(args)) (routed.has(k.toLowerCase()) ? outer : body)[k] = v;
    const bodyRequired = (def.inputSchema.required ?? []).includes("requestBody");
    return Object.keys(body).length || bodyRequired ? { ...outer, requestBody: body } : outer;
}
