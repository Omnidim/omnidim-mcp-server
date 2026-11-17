import { z } from 'zod';
import { jsonSchemaToZod } from 'json-schema-to-zod';

/**
 * Builds the zod schema that checks a tool's arguments. json-schema-to-zod's code
 * drops unknown keys, so it stays first. Its oneOf output carries TypeScript
 * generics that new Function cannot parse, so those tools use zod's own converter
 * instead of skipping validation.
 */
export function buildToolSchema(jsonSchema: unknown): z.ZodType {
    if (typeof jsonSchema !== 'object' || jsonSchema === null) return z.looseObject({});
    try {
        const schema = new Function('z', `return (${jsonSchemaToZod(jsonSchema as any)});`)(z);
        if (typeof schema?.parse === 'function') return schema;
    } catch {
        // Falls through to the native converter below.
    }
    return z.fromJSONSchema(jsonSchema as any);
}
