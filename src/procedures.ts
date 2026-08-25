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
- "Get me a number / buy a number" -> \`searchPhoneNumbers\` { region } then
  \`purchasePhoneNumber\`. This spends the account's balance, so confirm the
  exact number and price with the user before buying. \`releasePhoneNumber\`
  gives one up and cannot be undone.
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

// Provider recommendations by caller language, grounded in what works in
// production. Names match the createAgent enums (transcriber/voice/model).
const RECOMMENDED_STACK = `# Recommended provider stacks

Each agent uses a transcriber (speech-to-text), a voice (text-to-speech), and a
language model, all set on \`createAgent\`. The pairings below work well in
production, grouped by the language your callers speak. Use \`listSTTProviders\`,
\`listTTSProviders\`, \`listLLMProviders\`, and \`listVoices\` for the live catalog.

## Language model

- Default: \`gpt-4.1-mini\` — fast and accurate across languages, a good first
  choice for almost any agent.
- Alternatives: \`gemini-2.5-flash\`, \`gpt-4o\` (premium), \`gpt-4.1-nano\` (lighter).

## By caller language

- **Indian English (en-IN):** transcriber \`azure_stream\`; voice \`cartesia\`
  (default), \`eleven_labs\`, or \`google\`.
- **Hindi / Hinglish (mixed Hindi and English):** transcriber \`soniox\`
  (handles code-mixed speech in one stream); voice \`cartesia\` or \`eleven_labs\`.
- **Other Indian languages (Telugu, Bengali, etc.):** transcriber \`soniox\` or
  \`sarvam\` (tuned for Indian languages); voice \`cartesia\` or \`sarvam\`.
- **US / UK English:** transcriber \`azure_stream\` or \`deepgram_stream\`; voice
  \`cartesia\` or \`eleven_labs\`.

## Field notes

- \`transcriber.provider\` is one of \`deepgram_stream\`, \`azure_stream\`,
  \`soniox\`, \`sarvam\`, \`cartesia\`. \`deepgram_stream\` also needs a \`model\`
  (\`nova-3\` or \`nova-2\`); the others do not.
- \`voice.provider\` is one of \`cartesia\`, \`eleven_labs\`, \`google\`,
  \`sarvam\`. \`cartesia\` voices need a \`model\` such as \`sonic-3.5\`; for
  \`eleven_labs\` the model is implied by the voice.

## Responsiveness

- Keep the system prompt focused. Long prompts add latency to every turn.
- Verify your chosen voice on a short test call before launch (see
  \`omnidim://reference/voices\`).
`;

// How to choose a voice, with the synthesizable-voice gotcha and per-provider notes.
const VOICES_GUIDE = `# Choosing a voice

\`listVoices\` returns the catalog. Use a voice's \`name\` field as the
\`voice_id\` you pass to \`createAgent\`. Quality varies by language and not every
voice synthesizes cleanly, so always place a short test call and listen before
launch.

Filter \`listVoices\` by \`provider\` (\`cartesia\`, \`eleven_labs\`, \`google\`,
\`sarvam\`). ElevenLabs also supports \`language\`, \`accent\`, and \`gender\`.

By provider:

- **\`cartesia\`** — low-latency multilingual voices; the platform default. Pass a
  \`model\` such as \`sonic-3.5\`. Example voice_id
  \`bf0a246a-8642-498a-9950-80c35e9276b5\` ("Sophie", English female).
- **\`eleven_labs\`** — premium, expressive voices; the model is implied by the
  voice. Example voice_id \`JBFqnCBsd6RMkjVDRZzb\` ("George").
- **\`sarvam\`** — natural prosody for Indian languages.
- **\`google\`** — broad language coverage.
`;

// The createAgent field shape with two complete, copy-ready examples.
const AGENT_CONFIG_GUIDE = `# Building an agent with createAgent

On this server \`createAgent\` wraps its payload in \`requestBody\` (see the
routing guide). The fields inside:

- \`name\` — agent name.
- \`welcome_message\` — the first line the agent speaks.
- \`context_breakdown\` — a list of \`{ title, body }\` sections that form the
  agent's instructions.
- \`call_type\` — "Incoming" or "Outgoing".
- \`model\` — \`{ model, temperature? }\`, e.g. \`{ "model": "gpt-4.1-mini" }\`.
- \`voice\` — \`{ provider, voice_id, model? }\`. \`model\` (e.g. \`sonic-3.5\`)
  is only needed for \`cartesia\`.
- \`transcriber\` — \`{ provider, model?, language? }\`. \`model\` (\`nova-3\` /
  \`nova-2\`) is only needed for \`deepgram_stream\`.

## Example: Indian-English support agent (inbound)

{
  "requestBody": {
    "name": "Support agent",
    "welcome_message": "Hi, thanks for calling. How can I help you today?",
    "context_breakdown": [
      { "title": "Role", "body": "You are a friendly customer-support agent. Answer questions, and if you cannot help, offer to connect the caller to a human." }
    ],
    "call_type": "Incoming",
    "model": { "model": "gpt-4.1-mini" },
    "voice": { "provider": "cartesia", "model": "sonic-3.5", "voice_id": "bf0a246a-8642-498a-9950-80c35e9276b5" },
    "transcriber": { "provider": "azure_stream" }
  }
}

## Example: Hindi / Hinglish appointment reminder (outbound)

{
  "requestBody": {
    "name": "Appointment reminder",
    "welcome_message": "Namaste, main aapke appointment ke baare mein baat karne ke liye call kar rahi hoon.",
    "context_breakdown": [
      { "title": "Role", "body": "You remind customers about an upcoming appointment and confirm whether they can attend. Speak naturally in the caller's language, Hindi or English." }
    ],
    "call_type": "Outgoing",
    "model": { "model": "gpt-4.1-mini" },
    "voice": { "provider": "cartesia", "model": "sonic-3.5", "voice_id": "<pick one from listVoices>" },
    "transcriber": { "provider": "soniox" }
  }
}

Then give the agent a phone number and verify with a test call (the
\`provision_agent\` prompt walks through this end to end).
`;

const VERSIONING_GUIDE = `# Agent version history

A **version** is a frozen snapshot of an agent's configuration at a point in
time. Use it to save a known-good setup before a risky change, and to roll back
if a change makes the agent worse.

## The tools

- \`listAgentVersions\` { agent_id } - the timeline, newest first. Each entry has
  a \`version_number\`, a \`kind\`, who saved it, and a \`change_summary\` (a
  one-line "what changed in this version vs the one before it").
- \`createAgentVersion\` { agent_id, requestBody: { name, note? } } - save the
  agent's CURRENT config as a named version.
- \`diffAgentVersion\` { agent_id, version_number, against? } - what changed (see
  below).
- \`restoreAgentVersion\` { agent_id, version_number } - write a version back onto
  the live agent.
- \`renameAgentVersion\` / \`deleteAgentVersion\` - tidy the timeline.

\`kind\` is \`manual\` (a person saved it), \`auto\` (saved automatically a few
minutes after editing settles - you do NOT trigger these), or \`system\` (a
safety backup taken automatically right before a restore).

## When to snapshot

Call \`createAgentVersion\` right BEFORE you make a change you might want to undo
(swapping the model/voice, rewriting the prompt, changing transfer rules). Give
it a clear \`name\` ("before pricing-flow rewrite"). You do not need to snapshot
after routine edits - the platform auto-saves settled states on its own.

## How to read a diff

\`diffAgentVersion\` compares two snapshots and returns \`{ changed, groups }\`,
where each group is an area (Settings, Prompt, Transfer rules, Post-call actions,
Knowledge, Integrations, Web widget, Conversation flow, Other settings) with the
specific old -> new changes. Pick the comparison with \`against\`:

- **omit / \`against=previous\`** (default): what changed IN this version vs the
  one before it. This matches the \`change_summary\` in the list.
- **\`against=current\`**: what restoring this version WOULD change vs the agent's
  live config right now. Read this before a restore to preview the effect.
- **\`against=<number>\`**: compare with a specific other version.

## How to decide and perform a restore

1. \`listAgentVersions\` and scan \`change_summary\` to find the version you want.
2. \`diffAgentVersion\` { version_number, against: "current" } to preview exactly
   what restoring changes. If it says nothing meaningful changed, there is
   nothing to restore.
3. \`restoreAgentVersion\` { agent_id, version_number }. This first saves the
   current state as a \`system\` "Backup before restore" version (so the restore
   is itself undoable), then writes the chosen config back. The response
   includes a \`skipped\` list: references (knowledge files, integrations) that no
   longer exist are dropped and reported rather than failing the restore.
4. Confirm with \`listAgentVersions\` (a new \`system\` backup should appear) or
   \`getAgent\` to see the live config.

## Gotchas

- Version history is enabled per organization. If it is off for the caller's
  org, these endpoints return 403 (\`feature_disabled\`).
- \`createAgentVersion\` refuses a no-op: if nothing changed since the latest
  version it returns 409 (\`no_changes\`). Make (or intend) a real change first.
- There is a per-agent cap on versions created through the API; at the cap
  \`createAgentVersion\` returns 409 (\`version_limit_reached\`) - delete an old
  version to make room.
- \`listAgentVersions\` and \`diffAgentVersion\` are read-only and safe to call
  freely. Restore and delete mutate the live agent - confirm intent first.
`;

const RESOURCES: ResourceDef[] = [
    {
        uri: "omnidim://guide/routing",
        name: "OmniDimension routing guide",
        description: "Which tool to call when, ID flow between calls, and the non-obvious rules proven against the live API.",
        mimeType: "text/markdown",
        text: ROUTING_GUIDE,
    },
    {
        uri: "omnidim://reference/recommended-stack",
        name: "Recommended provider stacks by language",
        description: "Which transcriber (STT), voice (TTS), and language model to choose, grouped by the caller's language. Reflects what works in production.",
        mimeType: "text/markdown",
        text: RECOMMENDED_STACK,
    },
    {
        uri: "omnidim://reference/voices",
        name: "Choosing a voice",
        description: "How to pick a voice from listVoices (use the name as voice_id), per-provider notes, and the verify-on-a-test-call rule.",
        mimeType: "text/markdown",
        text: VOICES_GUIDE,
    },
    {
        uri: "omnidim://reference/agent-config",
        name: "Building an agent with createAgent",
        description: "The createAgent field shape with two complete, copy-ready example configurations (Indian-English support, Hindi/Hinglish reminder).",
        mimeType: "text/markdown",
        text: AGENT_CONFIG_GUIDE,
    },
    {
        uri: "omnidim://guide/agent-versioning",
        name: "Agent version history",
        description: "How to save, diff, and restore agent config snapshots: which tool to call, what the diff `against` modes mean, how to decide on a restore, and the 403/409 gotchas.",
        mimeType: "text/markdown",
        text: VERSIONING_GUIDE,
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
   number exists, either buy one (\`searchPhoneNumbers\` { region } then
   \`purchasePhoneNumber\`, which charges the account, so confirm with the user
   first and never pick for them) or import one you already own
   (importTwilioNumber / importExotelNumber / importSipTrunk).
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
    {
        name: "restore_agent_version",
        description: "Safely roll an agent back to an earlier saved version: find the right snapshot, preview exactly what restoring changes, then restore.",
        arguments: [
            { name: "agent_id", description: "The agent to roll back (the listAgents / createAgent id).", required: true },
            { name: "goal", description: "What you want to get back to, in plain language (e.g. 'the version before I broke the transfer flow').", required: false },
        ],
        build: (a) => {
            const agentId = a.agent_id || "<agent_id>";
            const goal = a.goal || "(describe which earlier state you want back)";
            return `Roll agent ${agentId} back to an earlier version.

Goal: "${goal}"

Follow these steps in order. Do NOT restore blindly, preview first.

1. \`listAgentVersions\` { agent_id: ${agentId} }. Versions come newest first;
   each has a \`version_number\`, \`kind\` (manual / auto / system), who saved it,
   when, and a \`change_summary\` (what changed in that version). Use the names,
   timestamps, and change summaries to find the one that matches the goal above.
   If the feature is off for this org these calls return 403 (feature_disabled);
   report that and stop.
2. Preview the effect: \`diffAgentVersion\` { agent_id: ${agentId}, version_number: <chosen>, against: "current" }.
   This shows exactly what restoring that version WOULD change vs the agent's
   live config, grouped by area (Settings, Prompt, Transfer rules, etc.). If it
   reports no meaningful change, tell the user there is nothing to restore and
   stop. Show the user this preview and confirm before the next step.
3. Restore: \`restoreAgentVersion\` { agent_id: ${agentId}, version_number: <chosen> }.
   This automatically saves the current state as a "Backup before restore"
   version first (so the restore is itself undoable), then writes the chosen
   config back. Check the response's \`skipped\` list: knowledge files or
   integrations that no longer exist are dropped and reported, not restored.
4. Confirm: \`listAgentVersions\` again (a new system "Backup before restore"
   entry should be at the top) and tell the user they can undo by restoring it.

See the \`omnidim://guide/agent-versioning\` resource for the full tool list and
the diff \`against\` modes.`;
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
