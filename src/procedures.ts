/**
 * Procedure layer: MCP prompts (parameterized procedures) and resources
 * (reference material) that sit on top of the raw API tools. The tools say
 * WHAT can be called; these say which tool to call WHEN, in what order, with
 * which payload shape, and which gotchas to avoid. Every step here was proven
 * against the live API before being written down.
 */
import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
    GetPromptRequestSchema,
    ListPromptsRequestSchema,
    ListResourcesRequestSchema,
    ReadResourceRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

interface PromptArg { name: string; description: string; required?: boolean; }
interface PromptDef {
    name: string;
    description: string;
    arguments: PromptArg[];
    build: (args: Record<string, string>) => string;
}
interface ResourceDef { uri: string; name: string; description: string; mimeType: string; text: string; }

/**
 * Cross-cutting routing reference. An agent reads this to learn the platform
 * shape and the non-obvious rules that the per-operation tool schemas do not
 * surface on their own.
 */
const ROUTING_GUIDE = `# OmniDimension routing guide

OmniDimension is a voice AI platform. You create an **agent** (a.k.a. "bot"),
give it a **phone number** and optionally a **knowledge base**, then place
**calls** (one-off or as a bulk **campaign**) and read **call logs**.

## How to pick the right tool

- "Create / set up an agent that does X" -> the \`provision_agent\` prompt.
- "Why did calls fail / what happened on a call / summarize calls" -> the
  \`audit_calls\` prompt, then \`listCallLogs\` + \`getCallLog\`.
- "List / inspect what exists" -> \`listAgents\`, \`listPhoneNumbers\`,
  \`listVoices\`, \`listKnowledgeBaseFiles\`.
- "Place one call now" -> \`dispatchCall\`. "Call many contacts" -> the bulk
  call tools.

## Rules that are easy to get wrong (proven against the live API)

1. **Write tools wrap their payload in \`requestBody\`.** \`createAgent\`,
   \`updateAgent\`, \`attachPhoneNumber\`, \`dispatchCall\`, etc. all take
   \`{ "requestBody": { ... } }\`. Flat arguments fail validation.
2. **Voices: use the \`name\` string as \`voice_id\`.** \`listVoices\` returns
   \`id: null\` for most voices; the usable identifier is the \`name\` field.
   Not every listed voice is synthesizable: an arbitrary one can produce a
   silent call. Prefer a known premade voice and confirm audio on a test call.
3. **The agent's numeric \`voice\` field is not used for speech.** It can read
   back as \`false\` on an API-created agent; that is normal. The call handler
   uses \`voice_external_id\` + \`voice_provider\`.
4. **Set a transcriber** (e.g. \`deepgram_stream\` / \`nova-3\` / \`en-US\`).
5. **\`dispatchCall\` returning \`success: true\` does NOT mean a call
   connected.** It means the request was accepted. Proof of a real call is a
   resulting entry in \`listCallLogs\` whose \`getCallLog\` shows a non-empty
   \`call_conversation\`. Never treat the dispatch response as the outcome.
6. **Reading agents:** \`getAgent\` reports \`voice: false\`; read
   \`voice_external_id\` for the configured voice. \`listAgents\` puts the voice
   in the \`voice\` field. Do not report "no voice" from \`getAgent.voice\`.
7. **\`listCallLogs\` rows are large** and the response is trimmed if it grows
   past the size cap. Use a small \`pagesize\` (1-3) and fetch detail per row
   with \`getCallLog\`.
8. **Outbound \`from_number_id\`:** omit it to use the platform default number.
   A number that cannot reach the destination country yields an accepted
   dispatch but no connected call.
9. **IDs flow between calls:** \`createAgent\` -> \`id\` (the agent_id used
   everywhere downstream); \`listPhoneNumbers\` -> \`id\` (used as
   \`phone_number_id\` to attach and as \`from_number_id\` to dispatch).
10. **Phone numbers are E.164 with a leading \`+\`** everywhere.
`;

const RESOURCES: ResourceDef[] = [
    {
        uri: "omnidim://guide/routing",
        name: "OmniDimension routing guide",
        description: "Which tool to call when, ID flow between calls, and the non-obvious rules proven against the live API.",
        mimeType: "text/markdown",
        text: ROUTING_GUIDE,
    },
];

const PROMPTS: PromptDef[] = [
    {
        name: "provision_agent",
        description: "Create a working voice agent end to end: configure it, give it a number, and verify it can place a call and speak.",
        arguments: [
            { name: "purpose", description: "What the agent should do, in plain language (e.g. 'book dental appointments and answer FAQs').", required: true },
            { name: "voice_id", description: "Optional voice name from listVoices. If omitted, use a known premade voice and confirm audio on the test call.", required: false },
            { name: "test_number", description: "Optional E.164 number to place a verification call to after setup (e.g. +15551234567).", required: false },
        ],
        build: (a) => {
            const purpose = a.purpose || "(describe the agent's job)";
            const voiceLine = a.voice_id
                ? `Use voice_id "${a.voice_id}" (the \`name\` from listVoices).`
                : `Call \`listVoices\` and pick a premade voice; use its \`name\` as voice_id. Remember not every listed voice synthesizes, so verify audio on the test call.`;
            const testLine = a.test_number
                ? `5. Place a verification call with \`dispatchCall\` { requestBody: { agent_id, to_number: "${a.test_number}" } } (omit from_number_id to use the default outbound number). Capture the returned requestId.
6. Poll \`listCallLogs\` { pagesize: 1 } until a new row appears for ${a.test_number}, then \`getCallLog\` on its id. The call is verified ONLY if \`call_conversation\` is non-empty (the agent actually spoke). A successful dispatch response alone is not proof.`
                : `5. (No test_number given.) Tell the user the agent is configured and offer to place a verification call to a number they control. Until a call log shows a non-empty \`call_conversation\`, do not claim the agent works end to end.`;
            return `Provision a working OmniDimension voice agent for this purpose:

"${purpose}"

Follow these steps in order. Each write tool wraps its payload in \`requestBody\`.

1. Voice + models: ${voiceLine} A good default model is gpt-4.1-mini.
2. Create the agent with \`createAgent\`:
   {
     "requestBody": {
       "name": "<short name>",
       "welcome_message": "<first line the agent speaks>",
       "context_breakdown": [ { "title": "Purpose", "body": "<the agent's instructions, derived from the purpose above>" } ],
       "call_type": "Outgoing",
       "model": { "model": "gpt-4.1-mini", "temperature": 0.5 },
       "voice": { "provider": "eleven_labs", "voice_id": "<voice name>" },
       "transcriber": { "provider": "deepgram_stream", "model": "nova-3", "language": "en-US" }
     }
   }
   Capture the returned \`id\` as agent_id. (\`status\` is always "Completed"; it is not a build signal.)
3. Give it a number: \`listPhoneNumbers\` -> pick a number \`id\`. Attach it with
   \`attachPhoneNumber\` { requestBody: { phone_number_id, agent_id } }. If no
   number exists, import one first (importTwilioNumber / importExotelNumber / importSipTrunk).
4. Optional knowledge base: \`uploadKnowledgeBaseFile\` then \`attachKnowledgeBaseFiles\` { requestBody: { file_ids, agent_id } }.
${testLine}

Throughout: phone numbers are E.164 with a leading \`+\`. See the \`omnidim://guide/routing\` resource for the full gotcha list.`;
        },
    },
    {
        name: "audit_calls",
        description: "Review and summarize call logs: find failures, inspect transcripts and sentiment, or audit a specific agent or campaign.",
        arguments: [
            { name: "focus", description: "What to look into, in plain language (e.g. 'why are calls failing', 'summarize today's calls for agent 123').", required: true },
            { name: "agent_id", description: "Optional agent id to filter to (the listAgents / createAgent id).", required: false },
            { name: "call_status", description: "Optional status filter. Note the enum uses a hyphen for no-answer: completed | busy | failed | no-answer.", required: false },
        ],
        build: (a) => {
            const focus = a.focus || "(describe what to look into)";
            const filters: string[] = ["\"pagesize\": 3"];
            if (a.agent_id) filters.push(`"agentid": ${a.agent_id}`);
            if (a.call_status) filters.push(`"call_status": "${a.call_status}"`);
            return `Audit OmniDimension call logs for this question:

"${focus}"

1. List recent calls with \`listCallLogs\` { ${filters.join(", ")} }.
   - Keep \`pagesize\` small (1-3). Each row is large and the response is
     trimmed past a size cap, so a big page comes back truncated and unparseable.
   - Filters: \`agentid\` (note: no underscore) for one agent, \`bulk_call_id\`
     for one campaign, \`call_status\` for triage. The status enum uses a hyphen:
     completed | busy | failed | no-answer.
   - Each row carries \`id\`, \`call_status\`, \`sentiment_score\`, cost, and a
     summary. There is no date-range filter; filter by \`time_of_call\`
     (MM/DD/YYYY HH:MM:SS) yourself if needed.
2. For each call of interest, call \`getCallLog\` { call_log_id: <row id> } for
   the full transcript (\`call_conversation\`), \`interactions\`,
   \`extracted_variables\`, \`recording_url\`, and per-turn latency/cost.
   Note: an empty \`call_conversation\` means the agent never spoke (a silent
   call), not that the call is missing.
3. Summarize the answer to "${focus}": group by status or agent, surface failure
   reasons and low-sentiment calls, and cite specific \`call_log_id\`s.

See the \`omnidim://guide/routing\` resource for the full gotcha list.`;
        },
    },
];

export function getPromptText(name: string, args: Record<string, string> = {}): string | null {
    const p = PROMPTS.find((x) => x.name === name);
    return p ? p.build(args) : null;
}
export function getResourceText(uri: string): string | null {
    const r = RESOURCES.find((x) => x.uri === uri);
    return r ? r.text : null;
}
export const PROMPT_NAMES = PROMPTS.map((p) => p.name);
export const RESOURCE_URIS = RESOURCES.map((r) => r.uri);

export function registerProcedures(server: Server): void {
    server.setRequestHandler(ListPromptsRequestSchema, async () => ({
        prompts: PROMPTS.map(({ name, description, arguments: args }) => ({ name, description, arguments: args })),
    }));
    server.setRequestHandler(GetPromptRequestSchema, async (request) => {
        const p = PROMPTS.find((x) => x.name === request.params.name);
        if (!p) throw new Error(`Unknown prompt: ${request.params.name}`);
        const args = (request.params.arguments ?? {}) as Record<string, string>;
        return {
            description: p.description,
            messages: [{ role: "user", content: { type: "text", text: p.build(args) } }],
        };
    });
    server.setRequestHandler(ListResourcesRequestSchema, async () => ({
        resources: RESOURCES.map(({ uri, name, description, mimeType }) => ({ uri, name, description, mimeType })),
    }));
    server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
        const r = RESOURCES.find((x) => x.uri === request.params.uri);
        if (!r) throw new Error(`Unknown resource: ${request.params.uri}`);
        return { contents: [{ uri: r.uri, mimeType: r.mimeType, text: r.text }] };
    });
}
