#!/usr/bin/env node
/**
 * OmniDimension MCP server.
 */
import { readApiKey } from "./credentials.js";
import { isInteractive, printInteractiveHelp, startupBanner, trimLargeResponse } from "./helpers.js";
import { beginSession, emitSessionCrash, emitSessionEnd, endSession, recordToolError, recordToolResult } from "./telemetry.js";
import { registerProcedures } from "./procedures.js";
import { toolAnnotations } from "./tool-annotations.js";
import { notifyUpdates } from "./update_notifier.js";


import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type Tool,
  type CallToolResult,
  type CallToolRequest
} from "@modelcontextprotocol/sdk/types.js";

import { z, ZodError } from 'zod';
import { jsonSchemaToZod } from 'json-schema-to-zod';
import axios, { type AxiosRequestConfig, type AxiosError } from 'axios';

/**
 * Type definition for JSON objects
 */
type JsonObject = Record<string, any>;

/**
 * Interface for MCP Tool Definition
 */
interface McpToolDefinition {
    name: string;
    description: string;
    inputSchema: any;
    method: string;
    pathTemplate: string;
    executionParameters: { name: string, in: string }[];
    requestBodyContentType?: string;
    securityRequirements: any[];
    tags?: string[];
    deprecated?: boolean;
}

/**
 * Server configuration
 */
export const SERVER_NAME = "OmniDimension";
export const SERVER_VERSION = "0.11.1";
// Base URL for the API. Pinned to production; not env-overridable.
export const API_BASE_URL = "https://backend.omnidim.io/api/v1";

/**
 * MCP Server instance
 */
const SERVER_INSTRUCTIONS = `OmniDimension is a voice AI platform. This server exposes tools for managing voice agents and call infrastructure.

Surfaces:
- Agents: create, list, get, update, delete voice agents (transcriber, LLM, voice, post-call actions, transfer rules, dynamic-variable templating).
- Calls: dispatchCall for a single outbound call, listCallLogs and getCallLog for history and transcripts.
- Bulk calls: campaign management with scheduling, retry, and live status.
- Knowledge base: upload PDFs and attach to agents.
- Phone numbers: list, attach to agents, import from Twilio, Exotel, or SIP.
- Providers: discover available LLMs, voices, STT, and TTS engines.

Conventions:
- List endpoints accept pageno (>= 1) and pagesize (1-150). Use name to filter.
- For details on one item, call get<Resource>(id) after listing.
- Dispatching calls: run listPhoneNumbers first. If the account has numbers, pass the chosen one as from_number_id. If it has none, omit from_number_id and the platform's default number is used. Never guess a from_number_id.
- Configure OMNIDIM_API_KEY in your MCP client config to authenticate.
- API reference: https://docs.omnidim.io`;

const server = new Server(
    { name: SERVER_NAME, version: SERVER_VERSION },
    { capabilities: { tools: {}, prompts: {}, resources: {} }, instructions: SERVER_INSTRUCTIONS }
);

// Prompts (procedures) and resources (reference) layered on top of the tools.
registerProcedures(server);

/**
 * Map of tool definitions by name
 */
const toolDefinitionMap: Map<string, McpToolDefinition> = new Map([

  ["createSession", {
    name: "createSession",
    description: `Create a voice Session: a short-lived, single-conversation
reservation that lets a client hold a live voice chat with your
agent. This is step 1 of 2. Creating the Session does not start any
audio on its own; it returns a \`ws_url\` that a client then connects
to over WebSocket to actually talk.

Call this endpoint from your server with your API key, and return
only the \`ws_url\` to your client. The API key must never reach the
browser. The \`ws_url\` is the only thing the client needs, and it is
safe to hand out because it is single-use and expires. For how to
connect and talk, see "Connect the client and talk" below the
request details.

(Tags: Sessions)`,
    inputSchema: {"type":"object","properties":{"requestBody":{"type":"object","required":["agent_id","type"],"properties":{"agent_id":{"type":"number","description":"ID of the agent the session talks to."},"type":{"type":"string","default":"voice","enum":["voice"],"description":"The session type. Only `voice` is supported."},"custom_variables":{"type":"object","additionalProperties":true,"description":"Per-session variables that personalize the conversation.\nSet server-side, so visitors cannot tamper with them.\n"},"metadata":{"type":"object","additionalProperties":true,"description":"Key-value pairs stored on the session for your own\ntracking (e.g. CRM or lead IDs). Not shared with the\nagent; echoed back as `metadata` in the post-call\nwebhook so you can correlate results with your records.\n"}},"description":"The JSON request body."}},"required":["requestBody"]},
    method: "post",
    pathTemplate: "/sessions/create",
    executionParameters: [],
    requestBodyContentType: "application/json",
    securityRequirements: [{"BearerAuth":[]}],
    tags: ["Sessions"],
    deprecated: false
  }],
  ["listAgents", {
    name: "listAgents",
    description: `Retrieve all agents for the authenticated user with pagination support.
(Tags: Agents)`,
    inputSchema: {"type":"object","properties":{"pageno":{"type":"integer","minimum":1,"default":1,"description":"Page number for pagination."},"pagesize":{"type":"integer","minimum":1,"default":30,"maximum":150,"description":"Number of items per page (max 150)."},"name":{"type":"string","description":"Filter agents whose name matches this substring (case-insensitive)."}}},
    method: "get",
    pathTemplate: "/agents",
    executionParameters: [{"name":"pageno","in":"query"},{"name":"pagesize","in":"query"},{"name":"name","in":"query"}],
    requestBodyContentType: undefined,
    securityRequirements: [{"BearerAuth":[]}],
    tags: ["Agents"],
    deprecated: false
  }],
  ["createAgent", {
    name: "createAgent",
    description: `Create a new agent with the provided configuration. The full
config supports transcriber, model, voice, web search, transfer,
end-call conditions, post-call actions (email + webhook),
ambient background track, initial ringing sound, and multilingual support.

> **Voicemail detection is an access-gated feature** that we turn on per
account. If it isn't enabled for yours yet,
[request access](https://omnidim.io/contact-us?reason=product&lock=1)
before configuring the \`voicemail\` object.

(Tags: Agents)`,
    inputSchema: {"type":"object","properties":{"requestBody":{"allOf":[{"type":"object","description":"Agent configuration.","properties":{"name":{"type":"string","description":"Name for the agent.","example":"Customer Support Agent"},"welcome_message":{"type":"string","description":"Initial message the agent will say when answering a call.","example":"Hello! How can I help you today?"},"is_welcome_message_dynamic":{"type":"boolean","description":"When true, the welcome message is treated as a directive the agent uses to generate a tailored greeting for each call, rather than being spoken word for word. When false, the welcome message is spoken exactly as written."},"is_welcome_message_interruption":{"type":"boolean","description":"Allow the caller to interrupt the welcome message. When false, the agent finishes speaking the welcome before listening."},"is_interruption_allowed":{"type":"boolean","description":"Global toggle for whether the caller can interrupt the agent mid-sentence at any point in the call."},"dynamic_variables":{"type":"object","description":"Key/value map used to substitute placeholders in the agent's\nprompt and welcome message at call time. Reference a variable\nin your prompt with `{{variable_name}}`. Useful for\npersonalising the same agent across many calls.\n","additionalProperties":{"type":"string"},"example":{"customer_name":"Jane Doe","order_id":"ORD-12345"}},"context_breakdown":{"type":"array","description":"List of context breakdowns, each containing `title`, `body`, and optional `is_enabled`.","items":{"type":"object","required":["title","body"],"properties":{"title":{"type":"string","description":"Title of the breakdown.","example":"Purpose"},"body":{"type":"string","description":"Body of the breakdown, the detailed prompt content.","example":"This agent helps customers with product inquiries and support issues."},"is_enabled":{"type":"boolean","default":true,"description":"Whether this section is included in the prompt."}}}},"call_type":{"type":"string","enum":["Incoming","Outgoing"],"description":"Call type of the assistant."},"timezone":{"type":"string","description":"IANA timezone for this agent, for example `Asia/Kolkata`. Sets the local date and time the agent works with during calls. If not set, the account timezone is used as fallback. Pass an empty string to clear it.","example":"America/New_York"},"transcriber":{"type":"object","description":"Configuration for the speech-to-text transcriber.","properties":{"provider":{"type":"string","enum":["deepgram_stream","cartesia","sarvam","azure_stream","soniox"],"description":"The speech-to-text provider to use.","example":"deepgram_stream"},"model":{"type":"string","enum":["nova-3","nova-2"],"description":"The model to use for transcription (required when provider is `deepgram_stream`).","example":"nova-3"},"language":{"type":"string","description":"Language code for the transcriber. Format and supported\nvalues depend on the provider (e.g. `en-US` for Deepgram,\n`hi-IN` for Sarvam). Applies regardless of which\n`provider` is selected.\n","example":"en-US"},"silence_timeout_ms":{"type":"integer","description":"Silence timeout in milliseconds.","example":400},"should_apply_noise_reduction":{"type":"boolean","description":"Reduce background noise on the inbound audio stream before transcription."},"interruption_min_words":{"type":"integer","minimum":1,"description":"Minimum number of words the caller must say before their speech is treated as an interruption.","example":2},"max_call_duration_in_sec":{"type":"integer","minimum":1,"description":"Hard upper bound on call length in seconds. The agent will end the call once this is reached.","example":600},"first_ideal_message":{"type":"string","description":"First nudge spoken when the caller goes silent past the\nidle threshold. Set `is_first_ideal_message_dynamic` to\n`true` to have the LLM regenerate this each time.\n"},"is_first_ideal_message_dynamic":{"type":"boolean","description":"When true, `first_ideal_message` is treated as a prompt and the LLM generates a fresh nudge each call."},"second_ideal_message":{"type":"string","description":"Second nudge spoken if silence continues after the first."},"is_second_ideal_message_dynamic":{"type":"boolean","description":"When true, `second_ideal_message` is treated as a prompt and the LLM generates a fresh nudge each call."},"numerals":{"type":"boolean","description":"Convert numbers from words to digits."},"punctuate":{"type":"boolean","description":"Add punctuation to the transcript."},"smart_format":{"type":"boolean","description":"Apply smart formatting to the transcript."},"diarize":{"type":"boolean","description":"Identify different speakers in the transcript."}}},"model":{"type":"object","description":"Configuration for the language model.","properties":{"model":{"type":"string","enum":["azure-gpt-4.1-mini","azure-gpt-4.1-nano","azure-gpt-4o","azure-gpt-4o-mini","gemini-2.5-flash","gemini-2.5-flash-lite","gpt-3.5-turbo","gpt-4.1-mini","gpt-4.1-nano","gpt-4o","gpt-4o-mini","gpt-5.1","llama-3.3-70b-versatile"],"description":"The language model to use. The current catalog is returned by the LLM providers list.","example":"gpt-4.1-mini"},"temperature":{"type":"number","minimum":0,"maximum":1,"description":"Controls randomness in the model's output (0.0 to 1.0).","example":0.7}}},"voice":{"type":"object","description":"Configuration for the text-to-speech voice. `provider` and `voice_id` identify the voice together, so send both to change it. `provider` on its own is not accepted, and a `voice_id` on its own leaves the voice as it was. The other fields here apply independently.","dependentRequired":{"provider":["voice_id"]},"properties":{"provider":{"type":"string","enum":["eleven_labs","google","cartesia","sarvam"],"description":"The voice provider to use. The current catalog is returned by the TTS providers list. Send `voice_id` alongside it.","example":"eleven_labs"},"voice_id":{"type":"string","description":"The provider's voice identifier, returned in the `name` field of the voices list (not the numeric `id`). Takes effect when `provider` is sent alongside it.","example":"JBFqnCBsd6RMkjVDRZzb"},"model":{"type":"string","description":"TTS model identifier. Only consumed when `provider` is\n`cartesia` (e.g. `sonic-3.5`). For ElevenLabs and other\nproviders the model is implied by `voice_id` and this\nfield is ignored.\n","example":"sonic-3.5"},"speech_speed":{"type":"number","minimum":0.5,"maximum":2,"default":1,"description":"Playback speed multiplier for the agent's voice. 1.0 is normal speed."}}},"web_search":{"type":"object","description":"Configuration for web search capabilities.","properties":{"enabled":{"type":"boolean","description":"Enable or disable web search functionality."},"provider":{"type":"string","enum":["DuckDuckGo"],"description":"The search provider to use.","example":"DuckDuckGo"}}},"post_call_actions":{"type":"object","description":"Side effects that fire once the call ends. Configure email, webhook, or both.","properties":{"email":{"type":"object","properties":{"enabled":{"type":"boolean"},"recipients":{"type":"array","description":"Email addresses that should receive the notification.","items":{"type":"string","format":"email"},"example":["support@example.com"]},"include":{"type":"array","description":"Which sections to include in the email body.","items":{"type":"string","enum":["summary","extracted_variables","fullConversation","sentiment"]}},"extracted_variables":{"type":"array","description":"Variables the model should pull out of the conversation for the email.","items":{"type":"object","required":["key","prompt"],"properties":{"key":{"type":"string","description":"Unique identifier for the variable in the post-call payload.","example":"customer_issue"},"prompt":{"type":"string","description":"Instruction for the model on what to pull out of the conversation.","example":"Identify the main issue the customer is experiencing."}}}},"trigger_call_statuses":{"type":"array","description":"Call outcomes that should fire this action. Omit to\nuse the default (`completed`, `voicemail_detected`).\nPass an explicit list to also include failed calls,\nno-answers, busy signals, etc.\n","items":{"type":"string","enum":["completed","voicemail_detected","failed","no_answer","busy","cancelled"]},"example":["completed","voicemail_detected"]}}},"webhook":{"type":"object","properties":{"enabled":{"type":"boolean"},"url":{"type":"string","format":"uri","description":"Endpoint that receives a POST with the call payload.","example":"https://your-webhook-endpoint.com/omnidim-callback"},"include":{"type":"array","description":"Which sections to include in the webhook body.","items":{"type":"string","enum":["summary","extracted_variables","fullConversation","sentiment"]}},"extracted_variables":{"type":"array","description":"Variables the model should pull out of the conversation for the webhook.","items":{"type":"object","required":["key","prompt"],"properties":{"key":{"type":"string","description":"Unique identifier for the variable in the post-call payload.","example":"customer_issue"},"prompt":{"type":"string","description":"Instruction for the model on what to pull out of the conversation.","example":"Identify the main issue the customer is experiencing."}}}},"trigger_call_statuses":{"type":"array","description":"Call outcomes that should fire this webhook. Omit to\nuse the default (`completed`, `voicemail_detected`).\n","items":{"type":"string","enum":["completed","voicemail_detected","failed","no_answer","busy","cancelled"]},"example":["completed","failed"]}}}}},"transfer":{"type":"object","description":"Conditional call transfer to a human agent or another number.","properties":{"enabled":{"type":"boolean"},"transfer_options":{"type":"array","description":"Where to transfer the call and under what condition. The first matching condition wins. In an agent update, sending this list replaces all saved options. Omit it to keep them unchanged, or send an empty array to clear them.","items":{"type":"object","required":["number","transfer_condition","transfer_message"],"properties":{"number":{"type":"string","description":"Primary phone number to transfer to. Include country code with leading `+`.","example":"+15551234567"},"type":{"type":"string","enum":["static","dynamic"],"default":"static","description":"`static` transfers to `number`. `dynamic` lets the agent\npick a number at runtime based on the conversation.\n"},"backup_numbers":{"type":"array","description":"Fallback numbers tried if the primary is unreachable.","items":{"type":"string"}},"transfer_condition":{"type":"string","description":"Natural-language condition that triggers this transfer option.","example":"Transfer if the customer asks to speak with a human."},"transfer_message":{"type":"string","description":"Message the agent says to the caller before executing the transfer.","example":"Please hold while I connect you to one of our agents."}}}}}},"end_call":{"type":"object","description":"Hang up automatically when a condition is met.","properties":{"enabled":{"type":"boolean"},"condition":{"type":"string","description":"Natural-language condition that triggers ending the call. Only evaluated when `enabled` is true.","example":"End the call once the customer's issue is resolved."},"message":{"type":"string","description":"What the agent says before hanging up.","example":"Thank you for contacting us. Have a great day!"},"message_type":{"type":"string","enum":["static","prompt"],"description":"`static` speaks `message` verbatim. `prompt` treats\n`message_prompt` as an LLM instruction and generates a\nfresh closing line each call (useful for matching the\ncaller's language and tone).\n"},"message_prompt":{"type":"string","description":"LLM prompt used to generate the closing line when `message_type` is `prompt`.","example":"End the call politely in the same language the user is speaking."}}},"background_track":{"type":"object","description":"Ambient background noise that plays under the agent's voice.","properties":{"enabled":{"type":"boolean","description":"Whether to mix the ambient track under the agent's audio."},"name":{"type":"string","enum":["call_center","filler","office","office_1","restaurant"],"description":"Ambient track to mix under the agent."},"volume":{"type":"number","minimum":0,"maximum":1,"default":0.2,"description":"Volume level on a 0–1 scale. Default 0.2."},"tts_volume_reduction":{"type":"number","minimum":0,"maximum":1,"description":"Amount to drop the agent's TTS volume while the ambient track plays, on a 0–1 scale. Helps the voice cut through without raising the overall mix."}}},"initial_ringing_sound_enabled":{"type":"boolean","description":"Plays a ringing tone after the call is picked up, until the agent starts speaking."},"voicemail":{"type":"object","description":"Voicemail / answering-machine handling for outbound calls. Set this with the nested object shown here; the agent object returns these values as the flat fields `voicemail_enabled` and `voicemail_message`. Voicemail detection is an access-gated feature. If it isn't enabled for your account, [request access](https://omnidim.io/contact-us?reason=product&lock=1).","properties":{"enabled":{"type":"boolean","description":"Detect voicemail and leave your message instead of speaking to a machine."},"message":{"type":"string","description":"Message to leave when voicemail is detected."}}},"languages":{"type":"array","description":"Languages the agent should support. Pass each language as a display-name string exactly as it appears in the dashboard's language picker. Unrecognized names are skipped.","items":{"type":"string"},"example":["English (India)","Hindi"]}}},{"type":"object","required":["name","welcome_message","context_breakdown"]}],"description":"The JSON request body."}},"required":["requestBody"]},
    method: "post",
    pathTemplate: "/agents/create",
    executionParameters: [],
    requestBodyContentType: "application/json",
    securityRequirements: [{"BearerAuth":[]}],
    tags: ["Agents"],
    deprecated: false
  }],
  ["getAgent", {
    name: "getAgent",
    description: `Get details of a specific agent by ID. The response also includes a \`version_history_enabled\` boolean showing whether [version history](/docs/api-reference/agents/listAgentVersions) is turned on for the agent's organization.
(Tags: Agents)`,
    inputSchema: {"type":"object","properties":{"agent_id":{"type":"number","description":"The ID of the agent."}},"required":["agent_id"]},
    method: "get",
    pathTemplate: "/agents/{agent_id}",
    executionParameters: [{"name":"agent_id","in":"path"}],
    requestBodyContentType: undefined,
    securityRequirements: [{"BearerAuth":[]}],
    tags: ["Agents"],
    deprecated: false
  }],
  ["updateAgent", {
    name: "updateAgent",
    description: `Update an existing agent. Send only the fields you want to change.

> **Voicemail detection is an access-gated feature** that we turn on per account. If it isn't enabled for yours yet, [request access](https://omnidim.io/contact-us?reason=product&lock=1) before configuring the \`voicemail\` object below.
(Tags: Agents)`,
    inputSchema: {"type":"object","properties":{"agent_id":{"type":"number","description":"The ID of the agent."},"requestBody":{"type":"object","description":"Agent configuration.","properties":{"name":{"type":"string","description":"Name for the agent."},"welcome_message":{"type":"string","description":"Initial message the agent will say when answering a call."},"is_welcome_message_dynamic":{"type":"boolean","description":"When true, the welcome message is treated as a directive the agent uses to generate a tailored greeting for each call, rather than being spoken word for word. When false, the welcome message is spoken exactly as written."},"is_welcome_message_interruption":{"type":"boolean","description":"Allow the caller to interrupt the welcome message. When false, the agent finishes speaking the welcome before listening."},"is_interruption_allowed":{"type":"boolean","description":"Global toggle for whether the caller can interrupt the agent mid-sentence at any point in the call."},"dynamic_variables":{"type":"object","description":"Key/value map used to substitute placeholders in the agent's\nprompt and welcome message at call time. Reference a variable\nin your prompt with `{{variable_name}}`. Useful for\npersonalising the same agent across many calls.\n","additionalProperties":{"type":"string"}},"context_breakdown":{"type":"array","description":"List of context breakdowns, each containing `title`, `body`, and optional `is_enabled`.","items":{"type":"object","required":["title","body"],"properties":{"title":{"type":"string","description":"Title of the breakdown."},"body":{"type":"string","description":"Body of the breakdown, the detailed prompt content."},"is_enabled":{"type":"boolean","default":true,"description":"Whether this section is included in the prompt."}}}},"call_type":{"type":"string","enum":["Incoming","Outgoing"],"description":"Call type of the assistant."},"timezone":{"type":"string","description":"IANA timezone for this agent, for example `Asia/Kolkata`. Sets the local date and time the agent works with during calls. If not set, the account timezone is used as fallback. Pass an empty string to clear it."},"transcriber":{"type":"object","description":"Configuration for the speech-to-text transcriber.","properties":{"provider":{"type":"string","enum":["deepgram_stream","cartesia","sarvam","azure_stream","soniox"],"description":"The speech-to-text provider to use."},"model":{"type":"string","enum":["nova-3","nova-2"],"description":"The model to use for transcription (required when provider is `deepgram_stream`)."},"language":{"type":"string","description":"Language code for the transcriber. Format and supported\nvalues depend on the provider (e.g. `en-US` for Deepgram,\n`hi-IN` for Sarvam). Applies regardless of which\n`provider` is selected.\n"},"silence_timeout_ms":{"type":"number","description":"Silence timeout in milliseconds."},"should_apply_noise_reduction":{"type":"boolean","description":"Reduce background noise on the inbound audio stream before transcription."},"interruption_min_words":{"type":"number","minimum":1,"description":"Minimum number of words the caller must say before their speech is treated as an interruption."},"max_call_duration_in_sec":{"type":"number","minimum":1,"description":"Hard upper bound on call length in seconds. The agent will end the call once this is reached."},"first_ideal_message":{"type":"string","description":"First nudge spoken when the caller goes silent past the\nidle threshold. Set `is_first_ideal_message_dynamic` to\n`true` to have the LLM regenerate this each time.\n"},"is_first_ideal_message_dynamic":{"type":"boolean","description":"When true, `first_ideal_message` is treated as a prompt and the LLM generates a fresh nudge each call."},"second_ideal_message":{"type":"string","description":"Second nudge spoken if silence continues after the first."},"is_second_ideal_message_dynamic":{"type":"boolean","description":"When true, `second_ideal_message` is treated as a prompt and the LLM generates a fresh nudge each call."},"numerals":{"type":"boolean","description":"Convert numbers from words to digits."},"punctuate":{"type":"boolean","description":"Add punctuation to the transcript."},"smart_format":{"type":"boolean","description":"Apply smart formatting to the transcript."},"diarize":{"type":"boolean","description":"Identify different speakers in the transcript."}}},"model":{"type":"object","description":"Configuration for the language model.","properties":{"model":{"type":"string","enum":["azure-gpt-4.1-mini","azure-gpt-4.1-nano","azure-gpt-4o","azure-gpt-4o-mini","gemini-2.5-flash","gemini-2.5-flash-lite","gpt-3.5-turbo","gpt-4.1-mini","gpt-4.1-nano","gpt-4o","gpt-4o-mini","gpt-5.1","llama-3.3-70b-versatile"],"description":"The language model to use. The current catalog is returned by the LLM providers list."},"temperature":{"type":"number","minimum":0,"maximum":1,"description":"Controls randomness in the model's output (0.0 to 1.0)."}}},"voice":{"type":"object","description":"Configuration for the text-to-speech voice. `provider` and `voice_id` identify the voice together, so send both to change it. `provider` on its own is not accepted, and a `voice_id` on its own leaves the voice as it was. The other fields here apply independently.","dependentRequired":{"provider":["voice_id"]},"properties":{"provider":{"type":"string","enum":["eleven_labs","google","cartesia","sarvam"],"description":"The voice provider to use. The current catalog is returned by the TTS providers list. Send `voice_id` alongside it."},"voice_id":{"type":"string","description":"The provider's voice identifier, returned in the `name` field of the voices list (not the numeric `id`). Takes effect when `provider` is sent alongside it."},"model":{"type":"string","description":"TTS model identifier. Only consumed when `provider` is\n`cartesia` (e.g. `sonic-3.5`). For ElevenLabs and other\nproviders the model is implied by `voice_id` and this\nfield is ignored.\n"},"speech_speed":{"type":"number","minimum":0.5,"maximum":2,"default":1,"description":"Playback speed multiplier for the agent's voice. 1.0 is normal speed."}}},"web_search":{"type":"object","description":"Configuration for web search capabilities.","properties":{"enabled":{"type":"boolean","description":"Enable or disable web search functionality."},"provider":{"type":"string","enum":["DuckDuckGo"],"description":"The search provider to use."}}},"post_call_actions":{"type":"object","description":"Side effects that fire once the call ends. Configure email, webhook, or both.","properties":{"email":{"type":"object","properties":{"enabled":{"type":"boolean"},"recipients":{"type":"array","description":"Email addresses that should receive the notification.","items":{"type":"string","format":"email"}},"include":{"type":"array","description":"Which sections to include in the email body.","items":{"type":"string","enum":["summary","extracted_variables","fullConversation","sentiment"]}},"extracted_variables":{"type":"array","description":"Variables the model should pull out of the conversation for the email.","items":{"type":"object","required":["key","prompt"],"properties":{"key":{"type":"string","description":"Unique identifier for the variable in the post-call payload."},"prompt":{"type":"string","description":"Instruction for the model on what to pull out of the conversation."}}}},"trigger_call_statuses":{"type":"array","description":"Call outcomes that should fire this action. Omit to\nuse the default (`completed`, `voicemail_detected`).\nPass an explicit list to also include failed calls,\nno-answers, busy signals, etc.\n","items":{"type":"string","enum":["completed","voicemail_detected","failed","no_answer","busy","cancelled"]}}}},"webhook":{"type":"object","properties":{"enabled":{"type":"boolean"},"url":{"type":"string","format":"uri","description":"Endpoint that receives a POST with the call payload."},"include":{"type":"array","description":"Which sections to include in the webhook body.","items":{"type":"string","enum":["summary","extracted_variables","fullConversation","sentiment"]}},"extracted_variables":{"type":"array","description":"Variables the model should pull out of the conversation for the webhook.","items":{"type":"object","required":["key","prompt"],"properties":{"key":{"type":"string","description":"Unique identifier for the variable in the post-call payload."},"prompt":{"type":"string","description":"Instruction for the model on what to pull out of the conversation."}}}},"trigger_call_statuses":{"type":"array","description":"Call outcomes that should fire this webhook. Omit to\nuse the default (`completed`, `voicemail_detected`).\n","items":{"type":"string","enum":["completed","voicemail_detected","failed","no_answer","busy","cancelled"]}}}}}},"transfer":{"type":"object","description":"Conditional call transfer to a human agent or another number.","properties":{"enabled":{"type":"boolean"},"transfer_options":{"type":"array","description":"Where to transfer the call and under what condition. The first matching condition wins. In an agent update, sending this list replaces all saved options. Omit it to keep them unchanged, or send an empty array to clear them.","items":{"type":"object","required":["number","transfer_condition","transfer_message"],"properties":{"number":{"type":"string","description":"Primary phone number to transfer to. Include country code with leading `+`."},"type":{"type":"string","enum":["static","dynamic"],"default":"static","description":"`static` transfers to `number`. `dynamic` lets the agent\npick a number at runtime based on the conversation.\n"},"backup_numbers":{"type":"array","description":"Fallback numbers tried if the primary is unreachable.","items":{"type":"string"}},"transfer_condition":{"type":"string","description":"Natural-language condition that triggers this transfer option."},"transfer_message":{"type":"string","description":"Message the agent says to the caller before executing the transfer."}}}}}},"end_call":{"type":"object","description":"Hang up automatically when a condition is met.","properties":{"enabled":{"type":"boolean"},"condition":{"type":"string","description":"Natural-language condition that triggers ending the call. Only evaluated when `enabled` is true."},"message":{"type":"string","description":"What the agent says before hanging up."},"message_type":{"type":"string","enum":["static","prompt"],"description":"`static` speaks `message` verbatim. `prompt` treats\n`message_prompt` as an LLM instruction and generates a\nfresh closing line each call (useful for matching the\ncaller's language and tone).\n"},"message_prompt":{"type":"string","description":"LLM prompt used to generate the closing line when `message_type` is `prompt`."}}},"background_track":{"type":"object","description":"Ambient background noise that plays under the agent's voice.","properties":{"enabled":{"type":"boolean","description":"Whether to mix the ambient track under the agent's audio."},"name":{"type":"string","enum":["call_center","filler","office","office_1","restaurant"],"description":"Ambient track to mix under the agent."},"volume":{"type":"number","minimum":0,"maximum":1,"default":0.2,"description":"Volume level on a 0–1 scale. Default 0.2."},"tts_volume_reduction":{"type":"number","minimum":0,"maximum":1,"description":"Amount to drop the agent's TTS volume while the ambient track plays, on a 0–1 scale. Helps the voice cut through without raising the overall mix."}}},"initial_ringing_sound_enabled":{"type":"boolean","description":"Plays a ringing tone after the call is picked up, until the agent starts speaking."},"voicemail":{"type":"object","description":"Voicemail / answering-machine handling for outbound calls. Set this with the nested object shown here; the agent object returns these values as the flat fields `voicemail_enabled` and `voicemail_message`. Voicemail detection is an access-gated feature. If it isn't enabled for your account, [request access](https://omnidim.io/contact-us?reason=product&lock=1).","properties":{"enabled":{"type":"boolean","description":"Detect voicemail and leave your message instead of speaking to a machine."},"message":{"type":"string","description":"Message to leave when voicemail is detected."}}},"languages":{"type":"array","description":"Languages the agent should support. Pass each language as a display-name string exactly as it appears in the dashboard's language picker. Unrecognized names are skipped.","items":{"type":"string"}}}}},"required":["agent_id","requestBody"]},
    method: "put",
    pathTemplate: "/agents/{agent_id}",
    executionParameters: [{"name":"agent_id","in":"path"}],
    requestBodyContentType: "application/json",
    securityRequirements: [{"BearerAuth":[]}],
    tags: ["Agents"],
    deprecated: false
  }],
  ["deleteAgent", {
    name: "deleteAgent",
    description: `Permanently delete an agent.
(Tags: Agents)`,
    inputSchema: {"type":"object","properties":{"agent_id":{"type":"number","description":"The ID of the agent."}},"required":["agent_id"]},
    method: "delete",
    pathTemplate: "/agents/{agent_id}",
    executionParameters: [{"name":"agent_id","in":"path"}],
    requestBodyContentType: undefined,
    securityRequirements: [{"BearerAuth":[]}],
    tags: ["Agents"],
    deprecated: false
  }],
  ["listAgentVersions", {
    name: "listAgentVersions",
    description: `List an agent's saved versions, newest first. Includes manual (named) versions, automatic versions, and system backups taken before a restore.
(Tags: Agents)`,
    inputSchema: {"type":"object","properties":{"agent_id":{"type":"number","description":"The ID of the agent."},"pageno":{"type":"integer","minimum":1,"default":1,"description":"Page number for pagination."},"pagesize":{"type":"integer","minimum":1,"default":30,"maximum":150,"description":"Number of items per page (max 150)."},"search":{"type":"string","description":"Filter versions whose name matches this substring (case-insensitive)."},"kind":{"type":"string","enum":["manual","auto","system"],"description":"Filter versions by kind."}},"required":["agent_id"]},
    method: "get",
    pathTemplate: "/agents/{agent_id}/versions",
    executionParameters: [{"name":"agent_id","in":"path"},{"name":"pageno","in":"query"},{"name":"pagesize","in":"query"},{"name":"search","in":"query"},{"name":"kind","in":"query"}],
    requestBodyContentType: undefined,
    securityRequirements: [{"BearerAuth":[]}],
    tags: ["Agents"],
    deprecated: false
  }],
  ["createAgentVersion", {
    name: "createAgentVersion",
    description: `Save the agent's current configuration as a named version.
(Tags: Agents)`,
    inputSchema: {"type":"object","properties":{"agent_id":{"type":"number","description":"The ID of the agent."},"requestBody":{"type":"object","required":["name"],"properties":{"name":{"type":"string","description":"Display name for the version."},"note":{"type":"string","description":"Optional note describing the version."}},"description":"The JSON request body."}},"required":["agent_id","requestBody"]},
    method: "post",
    pathTemplate: "/agents/{agent_id}/versions",
    executionParameters: [{"name":"agent_id","in":"path"}],
    requestBodyContentType: "application/json",
    securityRequirements: [{"BearerAuth":[]}],
    tags: ["Agents"],
    deprecated: false
  }],
  ["deleteAgentVersion", {
    name: "deleteAgentVersion",
    description: `Delete a saved version.
(Tags: Agents)`,
    inputSchema: {"type":"object","properties":{"agent_id":{"type":"number","description":"The ID of the agent."},"version_number":{"type":"number","description":"The version number, as returned in `version_number` from the list or save endpoints."}},"required":["agent_id","version_number"]},
    method: "delete",
    pathTemplate: "/agents/{agent_id}/versions/{version_number}",
    executionParameters: [{"name":"agent_id","in":"path"},{"name":"version_number","in":"path"}],
    requestBodyContentType: undefined,
    securityRequirements: [{"BearerAuth":[]}],
    tags: ["Agents"],
    deprecated: false
  }],
  ["renameAgentVersion", {
    name: "renameAgentVersion",
    description: `Rename a saved version or edit its note. Version history is immutable otherwise; only the name and note can change.
(Tags: Agents)`,
    inputSchema: {"type":"object","properties":{"agent_id":{"type":"number","description":"The ID of the agent."},"version_number":{"type":"number","description":"The version number, as returned in `version_number` from the list or save endpoints."},"requestBody":{"type":"object","properties":{"name":{"type":"string","description":"New display name for the version."},"note":{"type":"string","description":"New note for the version."}},"description":"The JSON request body."}},"required":["agent_id","version_number"]},
    method: "patch",
    pathTemplate: "/agents/{agent_id}/versions/{version_number}",
    executionParameters: [{"name":"agent_id","in":"path"},{"name":"version_number","in":"path"}],
    requestBodyContentType: "application/json",
    securityRequirements: [{"BearerAuth":[]}],
    tags: ["Agents"],
    deprecated: false
  }],
  ["diffAgentVersion", {
    name: "diffAgentVersion",
    description: `Get a record-level diff for this version. By default it shows what changed in this version compared with the version before it. Use \`against=current\` to compare with the agent's live config (what restoring this version would change), or \`against=<number>\` to compare with another version.
(Tags: Agents)`,
    inputSchema: {"type":"object","properties":{"agent_id":{"type":"number","description":"The ID of the agent."},"version_number":{"type":"number","description":"The version number, as returned in `version_number` from the list or save endpoints."},"against":{"type":"string","description":"What to compare against. Omit or `previous` for the version before this one (the default). `current` for the agent's live config. A version number to compare with that version."}},"required":["agent_id","version_number"]},
    method: "get",
    pathTemplate: "/agents/{agent_id}/versions/{version_number}/diff",
    executionParameters: [{"name":"agent_id","in":"path"},{"name":"version_number","in":"path"},{"name":"against","in":"query"}],
    requestBodyContentType: undefined,
    securityRequirements: [{"BearerAuth":[]}],
    tags: ["Agents"],
    deprecated: false
  }],
  ["restoreAgentVersion", {
    name: "restoreAgentVersion",
    description: `Restore a version onto the live agent. Your current setup is saved first as a backup version, so restoring is undoable. Configuration is brought back; any knowledge files or integrations that were deleted since this version was saved can't be re-linked, and are reported in \`skipped\`.
(Tags: Agents)`,
    inputSchema: {"type":"object","properties":{"agent_id":{"type":"number","description":"The ID of the agent."},"version_number":{"type":"number","description":"The version number, as returned in `version_number` from the list or save endpoints."}},"required":["agent_id","version_number"]},
    method: "post",
    pathTemplate: "/agents/{agent_id}/versions/{version_number}/restore",
    executionParameters: [{"name":"agent_id","in":"path"},{"name":"version_number","in":"path"}],
    requestBodyContentType: undefined,
    securityRequirements: [{"BearerAuth":[]}],
    tags: ["Agents"],
    deprecated: false
  }],
  ["dispatchCall", {
    name: "dispatchCall",
    description: `Initiate a call to a phone number using a specified agent. The
phone number must include a country code with a leading plus.

(Tags: Calls)`,
    inputSchema: {"type":"object","properties":{"requestBody":{"type":"object","required":["agent_id","to_number"],"properties":{"agent_id":{"type":"number","description":"The ID of the agent that will handle the call."},"to_number":{"type":"string","description":"The phone number to call. Must include country code (e.g., +15551234567)."},"from_number_id":{"type":"number","description":"Id of a phone number on your account to place the call from (see the phone number list endpoint). Omit to use the platform's default number."},"call_context":{"type":"object","description":"Optional context information as key-value pairs to be passed to the agent during the call. Can contain any custom fields relevant to your use case.","additionalProperties":true},"metadata":{"type":"object","additionalProperties":true,"description":"Key-value pairs stored on the call for your own tracking\n(e.g. CRM or lead IDs). Not shared with the agent; echoed\nback as `metadata` in the post-call webhook so you can\ncorrelate results with your records.\n"}},"description":"The JSON request body."}},"required":["requestBody"]},
    method: "post",
    pathTemplate: "/calls/dispatch",
    executionParameters: [],
    requestBodyContentType: "application/json",
    securityRequirements: [{"BearerAuth":[]}],
    tags: ["Calls"],
    deprecated: false
  }],
  ["listCallLogs", {
    name: "listCallLogs",
    description: `Retrieve call logs with pagination and optional filtering.
(Tags: Calls)`,
    inputSchema: {"type":"object","properties":{"pageno":{"type":"integer","minimum":1,"default":1,"description":"Page number for pagination."},"pagesize":{"type":"integer","minimum":1,"default":30,"maximum":150,"description":"Number of items per page."},"agentid":{"type":"number","description":"Filter by agent ID."},"call_status":{"type":"string","enum":["completed","busy","failed","no-answer"],"description":"Filter by call outcome."},"bulk_call_id":{"type":"number","description":"Filter by bulk-call campaign ID."}}},
    method: "get",
    pathTemplate: "/calls/logs",
    executionParameters: [{"name":"pageno","in":"query"},{"name":"pagesize","in":"query"},{"name":"agentid","in":"query"},{"name":"call_status","in":"query"},{"name":"bulk_call_id","in":"query"}],
    requestBodyContentType: undefined,
    securityRequirements: [{"BearerAuth":[]}],
    tags: ["Calls"],
    deprecated: false
  }],
  ["getCallLog", {
    name: "getCallLog",
    description: `Detailed information about a specific call (duration, status, transcript, sentiment, extracted variables).
(Tags: Calls)`,
    inputSchema: {"type":"object","properties":{"call_log_id":{"type":"number","description":"Id of the call log, as returned by the call log list."}},"required":["call_log_id"]},
    method: "get",
    pathTemplate: "/calls/logs/{call_log_id}",
    executionParameters: [{"name":"call_log_id","in":"path"}],
    requestBodyContentType: undefined,
    securityRequirements: [{"BearerAuth":[]}],
    tags: ["Calls"],
    deprecated: false
  }],
  ["fetchBulkCalls", {
    name: "fetchBulkCalls",
    description: `List bulk-call campaigns with pagination and optional status filter.
(Tags: Bulk calls)`,
    inputSchema: {"type":"object","properties":{"pageno":{"type":"integer","minimum":1,"default":1,"description":"Page number for pagination."},"pagesize":{"type":"integer","minimum":1,"default":10,"maximum":150,"description":"Items per page (max 150)."},"status":{"type":"string","description":"Filter by status (e.g. completed)."}}},
    method: "get",
    pathTemplate: "/calls/bulk_call",
    executionParameters: [{"name":"pageno","in":"query"},{"name":"pagesize","in":"query"},{"name":"status","in":"query"}],
    requestBodyContentType: undefined,
    securityRequirements: [{"BearerAuth":[]}],
    tags: ["Bulk calls"],
    deprecated: false
  }],
  ["createBulkCall", {
    name: "createBulkCall",
    description: `Create a new bulk-call campaign. Only name, phone_number_id and a
contact_list are needed to dial a list now; every other field adds
one behaviour on top (drafts, rotation, filtering, scheduling,
retries, dynamic feeding).

The guide below the field reference walks the whole journey: the
first campaign and its response, each behaviour with a working
request, every refusal message with its fix, and the endpoints that
operate a campaign once it runs.

(Tags: Bulk calls)`,
    inputSchema: {"type":"object","properties":{"requestBody":{"type":"object","required":["name","phone_number_id"],"properties":{"name":{"type":"string","description":"Name of the bulk call campaign."},"phone_number_id":{"type":"string","description":"The number this campaign calls from. With a `rotation`, the\nrotation numbers dial instead and this one is the standby.\n"},"bot_id":{"type":"number","description":"Agent to run the campaign. Defaults to the agent attached\nto `phone_number_id`; required when the number has none.\n"},"save_as_draft":{"type":"boolean","default":false,"description":"Store the campaign without dialing; start it later with the\nstart endpoint. See Drafts in the guide below.\n"},"call_conditions":{"type":"array","description":"Dial only the contacts that match every condition; the rest\nare kept as `Skipped`. See Filtering in the guide below.\n","items":{"type":"object","required":["column","operator","value"],"properties":{"column":{"type":"string","description":"Key on the contact row to test."},"operator":{"type":"string","default":"equals","enum":["equals","not_equals","contains","greater_than","less_than"],"description":"`contains` is case-insensitive. `greater_than` and\n`less_than` compare numerically, and a row whose value\nis not a number fails the condition rather than\nerroring.\n"},"value":{"type":"string"}}}},"rotation":{"type":"object","description":"Rotate the campaign across several of your numbers, so no\nsingle number burns out. See Rotation in the guide below.\n","required":["numbers"],"properties":{"numbers":{"type":"array","minItems":1,"description":"The numbers to rotate across; each must be yours and\nlisted once.\n","items":{"type":"object","required":["phone_number_id"],"properties":{"phone_number_id":{"type":"number","description":"One of your numbers, from List phone numbers."},"sequence":{"type":"number","default":10,"description":"Rotation order. Lowest dials first."}}}},"strategy":{"type":"string","default":"fixed_count","enum":["fixed_count","cpr_threshold","both","none"],"description":"When to move to the next number: every\n`calls_per_number` calls, on low health score, both, or\nnever.\n"},"calls_per_number":{"type":"number","default":50,"description":"Calls before moving on. Used by `fixed_count` and `both`."},"health_threshold":{"type":"number","default":30,"description":"Health score below which a number is rotated away from.\nUsed by `cpr_threshold` and `both`.\n"},"fallback":{"type":"string","default":"pause","enum":["pause","continue_best"],"description":"When every number is unhealthy: `pause` the campaign,\nor `continue_best` with the healthiest one.\n"}}},"is_dynamic":{"type":"boolean","default":false,"description":"A dynamic campaign stays alive accepting contacts via the\nadd-contact webhooks, and `contact_list` becomes optional.\n"},"contact_list":{"type":"array","description":"Who to call. Each row needs `phone_number`; any other key\nreaches the agent as context for that one call.\n","items":{"type":"object","required":["phone_number"],"properties":{"phone_number":{"type":"string","description":"Phone number in international format (e.g., +15551234567)."}},"additionalProperties":true}},"is_scheduled":{"type":"boolean","default":false,"description":"Whether the campaign should be scheduled for future execution."},"scheduled_datetime":{"type":"string","description":"Scheduled execution time in format `YYYY-MM-DD HH:MM:SS` (required if `is_scheduled` is true)."},"timezone":{"type":"string","default":"UTC","description":"Timezone for scheduled execution."},"concurrent_call_limit":{"type":"number","default":1,"minimum":1,"description":"Maximum number of concurrent calls allowed."},"enabled_reschedule_call":{"type":"boolean","default":false,"description":"Enable automatic call rescheduling. When enabled the system can reschedule unreachable calls."},"retry_config":{"type":"object","description":"Auto-retry configuration object containing retry settings.","properties":{"auto_retry":{"type":"boolean","default":false},"auto_retry_schedule":{"type":"string","enum":["immediately","next_day","scheduled_time"],"description":"When to retry failed calls."},"retry_schedule_days":{"type":"number","default":0,"minimum":0,"description":"Days to wait before a scheduled retry."},"retry_schedule_hours":{"type":"number","default":0,"minimum":0,"description":"Hours to wait before a scheduled retry."},"retry_limit":{"type":"number","default":1,"minimum":1,"maximum":10,"description":"Retry attempts, 1 to 10. To disable retries omit it and\nleave `auto_retry` false; never send `0`.\n"}}}},"description":"The JSON request body."}},"required":["requestBody"]},
    method: "post",
    pathTemplate: "/calls/bulk_call/create",
    executionParameters: [],
    requestBodyContentType: "application/json",
    securityRequirements: [{"BearerAuth":[]}],
    tags: ["Bulk calls"],
    deprecated: false
  }],
  ["addBulkCallContact", {
    name: "addBulkCallContact",
    description: `Push a single contact into a dynamic bulk-call campaign in real
time. Dynamic campaigns are created from the dashboard (Bulk Call
> Create New Campaign > Dynamic Campaign) and stay alive waiting
for contacts, so this webhook is how you feed them from a CRM,
form, or automation platform. The contact is queued immediately,
and the campaign starts calling it as soon as it is within
operating hours.

(Tags: Bulk calls)`,
    inputSchema: {"type":"object","properties":{"campaign_id":{"type":"number","description":"ID of the dynamic campaign to add the contact to."},"requestBody":{"type":"object","required":["to_number"],"properties":{"to_number":{"type":"string","description":"Contact phone number in international format (e.g., +15551234567)."},"custom_variables":{"type":"object","description":"Key-value pairs passed to the agent as context for this\ncall, so the agent can reference them during the\nconversation (e.g. the contact's name or reason for the\ncall). Match these keys to the variables used in your\nagent's welcome message or prompt.\n","additionalProperties":true},"metadata":{"type":"object","description":"Key-value pairs stored on the contact for your own\ntracking (e.g. CRM or lead IDs). Not shared with the\nagent.\n","additionalProperties":true}},"description":"The JSON request body."}},"required":["campaign_id","requestBody"]},
    method: "post",
    pathTemplate: "/calls/bulk_call/{campaign_id}/add_contact",
    executionParameters: [{"name":"campaign_id","in":"path"}],
    requestBodyContentType: "application/json",
    securityRequirements: [{"BearerAuth":[]}],
    tags: ["Bulk calls"],
    deprecated: false
  }],
  ["getBulkCall", {
    name: "getBulkCall",
    description: `Get detailed information about a bulk-call campaign.
(Tags: Bulk calls)`,
    inputSchema: {"type":"object","properties":{"bulk_call_id":{"type":"number","description":"Id of the bulk call campaign."}},"required":["bulk_call_id"]},
    method: "get",
    pathTemplate: "/calls/bulk_call/{bulk_call_id}",
    executionParameters: [{"name":"bulk_call_id","in":"path"}],
    requestBodyContentType: undefined,
    securityRequirements: [{"BearerAuth":[]}],
    tags: ["Bulk calls"],
    deprecated: false
  }],
  ["bulkCallActions", {
    name: "bulkCallActions",
    description: `Pause, resume, or reschedule a running campaign.
(Tags: Bulk calls)`,
    inputSchema: {"type":"object","properties":{"bulk_call_id":{"type":"number","description":"Id of the bulk call campaign."},"requestBody":{"type":"object","required":["action"],"properties":{"action":{"type":"string","enum":["pause","resume","reschedule"],"description":"What to do with the campaign."},"new_scheduled_datetime":{"type":"string","description":"New start time for `reschedule`. Format `YYYY-MM-DD HH:MM:SS`."},"new_timezone":{"type":"string","description":"IANA timezone for `reschedule`."}},"description":"The JSON request body."}},"required":["bulk_call_id","requestBody"]},
    method: "put",
    pathTemplate: "/calls/bulk_call/{bulk_call_id}",
    executionParameters: [{"name":"bulk_call_id","in":"path"}],
    requestBodyContentType: "application/json",
    securityRequirements: [{"BearerAuth":[]}],
    tags: ["Bulk calls"],
    deprecated: false
  }],
  ["cancelBulkCall", {
    name: "cancelBulkCall",
    description: `Cancel a bulk-call campaign.
(Tags: Bulk calls)`,
    inputSchema: {"type":"object","properties":{"bulk_call_id":{"type":"number","description":"Id of the bulk call campaign."}},"required":["bulk_call_id"]},
    method: "delete",
    pathTemplate: "/calls/bulk_call/{bulk_call_id}",
    executionParameters: [{"name":"bulk_call_id","in":"path"}],
    requestBodyContentType: undefined,
    securityRequirements: [{"BearerAuth":[]}],
    tags: ["Bulk calls"],
    deprecated: false
  }],
  ["listBulkCallLines", {
    name: "listBulkCallLines",
    description: `Per-contact results for a campaign: what happened on each call, the
variables you sent with that contact, and a pointer to the recording.

## Paging

There is one rule. Call it with no \`cursor\`, then keep passing back the
\`next_cursor\` you were handed until it comes back \`null\`.

\`\`\`
cursor = None
while True:
    page = GET /lines?pagesize=150&cursor={cursor}
    handle(page["records"])
    cursor = page["next_cursor"]
    if not cursor: break
\`\`\`

Each call returns a page of rows, oldest first: \`pagesize\` goes up to
150 and defaults to 30. Cursors are opaque, so pass back the string you
were given and never build one. No contact is skipped or returned
twice, even while the campaign is still dialing.

## Transcripts are not in the row

Each row carries \`call.recording_id\`, not the conversation. Transcripts
reach 212 KB, so carrying them here would make one page tens of
megabytes. Fetch the one you want from
\`GET /calls/logs/{recording_id}\`.

(Tags: Bulk calls)`,
    inputSchema: {"type":"object","properties":{"bulk_call_id":{"type":"number","description":"Id of the bulk call campaign."},"cursor":{"type":"string","description":"The `next_cursor` from your previous response. Omit it on the first\nrequest. Opaque: pass it back unchanged.\n"},"pagesize":{"type":"integer","minimum":1,"default":30,"maximum":150,"description":"Rows per page. Above 150 the request is refused."},"call_status":{"type":"string","enum":["Pending","In Progress","completed","voicemail_detected","no-answer","busy","Failed","Skipped","retry_scheduled","cancelled"],"description":"Return only contacts in this state."},"interaction_status":{"type":"string","description":"Return only contacts with this interaction outcome."},"search":{"type":"string","description":"An exact phone number, matched against the contact's number and the\nnumber that called it. Not a substring search.\n"},"include_total":{"type":"boolean","default":false,"description":"Add `total_records` to the response. It costs a count over the whole\nfiltered campaign, so it is off unless you ask. Ask for it once to\nfill a header, not on every page of a walk.\n"}},"required":["bulk_call_id"]},
    method: "get",
    pathTemplate: "/calls/bulk_call/{bulk_call_id}/lines",
    executionParameters: [{"name":"bulk_call_id","in":"path"},{"name":"cursor","in":"query"},{"name":"pagesize","in":"query"},{"name":"call_status","in":"query"},{"name":"interaction_status","in":"query"},{"name":"search","in":"query"},{"name":"include_total","in":"query"}],
    requestBodyContentType: undefined,
    securityRequirements: [{"BearerAuth":[]}],
    tags: ["Bulk calls"],
    deprecated: false
  }],
  ["listBulkCallNumbers", {
    name: "listBulkCallNumbers",
    description: `The campaign's number pool, and which number is dialing right now.

\`calls_this_cycle\` is what \`fixed_count\` rotation compares against, so
it is the field to watch for the next rotation. \`calls_dispatched\` is
the number's lifetime total across every cycle.

(Tags: Bulk calls)`,
    inputSchema: {"type":"object","properties":{"bulk_call_id":{"type":"number","description":"Id of the bulk call campaign."}},"required":["bulk_call_id"]},
    method: "get",
    pathTemplate: "/calls/bulk_call/{bulk_call_id}/numbers",
    executionParameters: [{"name":"bulk_call_id","in":"path"}],
    requestBodyContentType: undefined,
    securityRequirements: [{"BearerAuth":[]}],
    tags: ["Bulk calls"],
    deprecated: false
  }],
  ["addBulkCallNumber", {
    name: "addBulkCallNumber",
    description: `Add one of your numbers to the campaign's rotation pool. Works while the
campaign is running, which is how you bring in a fresh number when the
pool is running out of healthy ones.

The number must belong to you and must not already be in the pool. A
number with no agent attached gets this campaign's agent attached
automatically; a number attached to a **different** agent is refused.

(Tags: Bulk calls)`,
    inputSchema: {"type":"object","properties":{"bulk_call_id":{"type":"number","description":"Id of the bulk call campaign."},"requestBody":{"type":"object","required":["phone_number_id"],"properties":{"phone_number_id":{"type":"number","description":"One of your numbers, from List phone numbers."}},"description":"The JSON request body."}},"required":["bulk_call_id","requestBody"]},
    method: "post",
    pathTemplate: "/calls/bulk_call/{bulk_call_id}/numbers",
    executionParameters: [{"name":"bulk_call_id","in":"path"}],
    requestBodyContentType: "application/json",
    securityRequirements: [{"BearerAuth":[]}],
    tags: ["Bulk calls"],
    deprecated: false
  }],
  ["setBulkCallNumberActive", {
    name: "setBulkCallNumberActive",
    description: `Stop or resume dialing from one number in the pool.

Pausing is what you want when a number starts going bad mid-campaign:
dialing moves to the next number in sequence and the paused number keeps
its history and counters. The last active number of a running campaign
cannot be paused, since the campaign would have nothing to dial from.

Send the state you want rather than a toggle, so retrying the same
request is harmless.

\`assignment_id\` is the number's id **within this campaign's pool**, from
List rotation pool. It is not the \`phone_number_id\`.

(Tags: Bulk calls)`,
    inputSchema: {"type":"object","properties":{"bulk_call_id":{"type":"number","description":"Id of the bulk call campaign."},"assignment_id":{"type":"number","description":"The `assignment_id` from List rotation pool."},"requestBody":{"type":"object","required":["is_active"],"properties":{"is_active":{"type":"boolean","description":"`false` pauses the number, `true` resumes it."}},"description":"The JSON request body."}},"required":["bulk_call_id","assignment_id","requestBody"]},
    method: "put",
    pathTemplate: "/calls/bulk_call/{bulk_call_id}/numbers/{assignment_id}",
    executionParameters: [{"name":"bulk_call_id","in":"path"},{"name":"assignment_id","in":"path"}],
    requestBodyContentType: "application/json",
    securityRequirements: [{"BearerAuth":[]}],
    tags: ["Bulk calls"],
    deprecated: false
  }],
  ["addBulkCallContacts", {
    name: "addBulkCallContacts",
    description: `Add up to 1000 contacts to a campaign in one request.

This is the batch form of Add contact to dynamic campaign. Prefer it
whenever you have more than a handful: one request of 500 contacts is
far cheaper than 500 requests, on your side and ours.

Repeated numbers are kept, not merged. If the same number appears twice
with different variables, it is called twice, because two rows for one
number usually means two real reasons to call.

Rows that fail validation are reported in \`rejected\` and the rest are
still added, so a single bad number does not lose the batch. If the
campaign has \`call_conditions\`, rows that do not match are added with
status \`Skipped\`.

(Tags: Bulk calls)`,
    inputSchema: {"type":"object","properties":{"campaign_id":{"type":"number","description":"Id of the bulk call campaign."},"requestBody":{"type":"object","required":["contacts"],"properties":{"contacts":{"type":"array","maxItems":1000,"description":"Each row needs `to_number`. Note this differs from the\n`contact_list` on Create bulk call, which uses\n`phone_number` and takes loose keys: here the variables go\nin an explicit `custom_variables` object.\n","items":{"type":"object","required":["to_number"],"properties":{"to_number":{"type":"string","description":"Number to call, in international format."},"custom_variables":{"type":"object","description":"Passed to the agent as context for this call, so it\ncan use them in the conversation.\n","additionalProperties":true},"metadata":{"type":"object","description":"Stored with the contact and returned on its row in\nBulk call results. Not shown to the agent.\n","additionalProperties":true}}}}},"description":"The JSON request body."}},"required":["campaign_id","requestBody"]},
    method: "post",
    pathTemplate: "/calls/bulk_call/{campaign_id}/add_contacts",
    executionParameters: [{"name":"campaign_id","in":"path"}],
    requestBodyContentType: "application/json",
    securityRequirements: [{"BearerAuth":[]}],
    tags: ["Bulk calls"],
    deprecated: false
  }],
  ["startBulkCall", {
    name: "startBulkCall",
    description: `Start a campaign that was created with \`save_as_draft: true\`.

Drafts let you build a campaign over several requests: create it, add
contacts in batches, set the number pool, set concurrency, then start
when everything is in place. A campaign that is already running,
scheduled, or finished cannot be started.

(Tags: Bulk calls)`,
    inputSchema: {"type":"object","properties":{"bulk_call_id":{"type":"number","description":"Id of the bulk call campaign."}},"required":["bulk_call_id"]},
    method: "post",
    pathTemplate: "/calls/bulk_call/{bulk_call_id}/start",
    executionParameters: [{"name":"bulk_call_id","in":"path"}],
    requestBodyContentType: undefined,
    securityRequirements: [{"BearerAuth":[]}],
    tags: ["Bulk calls"],
    deprecated: false
  }],
  ["setBulkCallConcurrency", {
    name: "setBulkCallConcurrency",
    description: `Change how many calls the campaign places at once, including while it is
running. Raise it to finish sooner, lower it if your team cannot keep up
with transfers or your numbers are being answered less.

The ceiling is your account's concurrency limit.

(Tags: Bulk calls)`,
    inputSchema: {"type":"object","properties":{"bulk_call_id":{"type":"number","description":"Id of the bulk call campaign."},"requestBody":{"type":"object","required":["concurrent_call_limit"],"properties":{"concurrent_call_limit":{"type":"number","minimum":1,"description":"Calls to place at once."}},"description":"The JSON request body."}},"required":["bulk_call_id","requestBody"]},
    method: "put",
    pathTemplate: "/calls/bulk_call/{bulk_call_id}/concurrency",
    executionParameters: [{"name":"bulk_call_id","in":"path"}],
    requestBodyContentType: "application/json",
    securityRequirements: [{"BearerAuth":[]}],
    tags: ["Bulk calls"],
    deprecated: false
  }],
  ["retryBulkCall", {
    name: "retryBulkCall",
    description: `Re-queue contacts that did not connect, without creating a new campaign.

Use it after a campaign finishes with more no-answers than you expected,
or when the reason was on your side (a bad window, a number that was
having a bad day). Retried contacts keep their original variables.

(Tags: Bulk calls)`,
    inputSchema: {"type":"object","properties":{"bulk_call_id":{"type":"number","description":"Id of the bulk call campaign."},"requestBody":{"type":"object","properties":{"retry_strategy":{"type":"string","default":"all","description":"Which contacts to re-queue. `all` takes everything that did\nnot connect.\n"},"max_retries":{"type":"number","description":"Skip contacts already retried this many times."},"failure_reasons":{"type":"array","description":"Re-queue only contacts that failed for these reasons, for\nexample `no-answer` and `busy`.\n","items":{"type":"string"}}},"description":"The JSON request body."}},"required":["bulk_call_id"]},
    method: "post",
    pathTemplate: "/calls/bulk_call/{bulk_call_id}/manual_retry",
    executionParameters: [{"name":"bulk_call_id","in":"path"}],
    requestBodyContentType: "application/json",
    securityRequirements: [{"BearerAuth":[]}],
    tags: ["Bulk calls"],
    deprecated: false
  }],
  ["setBulkCallDailyTimeControl", {
    name: "setBulkCallDailyTimeControl",
    description: `Restrict a campaign to a daily calling window, in the campaign's
timezone. Outside the window the campaign holds rather than finishing,
and resumes the next day.

(Tags: Bulk calls)`,
    inputSchema: {"type":"object","properties":{"bulk_call_id":{"type":"number","description":"Id of the bulk call campaign."},"requestBody":{"type":"object","required":["enable_daily_hard_stop","enable_daily_auto_start"],"properties":{"enable_daily_hard_stop":{"type":"boolean","description":"Stop dialing at `daily_stop_time` each day."},"daily_stop_time":{"type":"number","description":"Hour of day to stop, 0 to 23. Fractions are allowed, so\n`17.5` is 17:30. Required when the hard stop is on.\n"},"daily_stop_timezone":{"type":"string","description":"Timezone for the stop time."},"enable_daily_auto_start":{"type":"boolean","description":"Resume dialing at `daily_start_time` each day."},"daily_start_time":{"type":"number","description":"Hour of day to resume, 0 to 23. Required when auto start\nis on.\n"},"daily_start_timezone":{"type":"string","description":"Timezone for the start time."}},"description":"The JSON request body."}},"required":["bulk_call_id","requestBody"]},
    method: "put",
    pathTemplate: "/calls/bulk_call/{bulk_call_id}/daily-time-control",
    executionParameters: [{"name":"bulk_call_id","in":"path"}],
    requestBodyContentType: "application/json",
    securityRequirements: [{"BearerAuth":[]}],
    tags: ["Bulk calls"],
    deprecated: false
  }],
  ["getBulkCallLiveStatus", {
    name: "getBulkCallLiveStatus",
    description: `Real-time status of a running bulk-call campaign.
(Tags: Bulk calls)`,
    inputSchema: {"type":"object","properties":{"bulk_call_id":{"type":"number","description":"Id of the bulk call campaign."}},"required":["bulk_call_id"]},
    method: "get",
    pathTemplate: "/bulk-call/{bulk_call_id}/live-status",
    executionParameters: [{"name":"bulk_call_id","in":"path"}],
    requestBodyContentType: undefined,
    securityRequirements: [{"BearerAuth":[]}],
    tags: ["Bulk calls"],
    deprecated: false
  }],
  ["listKnowledgeBaseFiles", {
    name: "listKnowledgeBaseFiles",
    description: `List all knowledge-base files for the authenticated user.
(Tags: Knowledge base)`,
    inputSchema: {"type":"object","properties":{}},
    method: "get",
    pathTemplate: "/knowledge_base/list",
    executionParameters: [],
    requestBodyContentType: undefined,
    securityRequirements: [{"BearerAuth":[]}],
    tags: ["Knowledge base"],
    deprecated: false
  }],
  ["canUploadFile", {
    name: "canUploadFile",
    description: `Check whether a file can be uploaded based on size and type.
(Tags: Knowledge base)`,
    inputSchema: {"type":"object","properties":{"requestBody":{"type":"object","required":["file_size","file_type"],"properties":{"file_size":{"type":"number","minimum":1,"description":"Size in bytes."},"file_type":{"type":"string","description":"File extension. Only `pdf` is accepted."}},"description":"The JSON request body."}},"required":["requestBody"]},
    method: "post",
    pathTemplate: "/knowledge_base/can_upload",
    executionParameters: [],
    requestBodyContentType: "application/json",
    securityRequirements: [{"BearerAuth":[]}],
    tags: ["Knowledge base"],
    deprecated: false
  }],
  ["uploadKnowledgeBaseFile", {
    name: "uploadKnowledgeBaseFile",
    description: `Upload a PDF file. The file content must be Base64 encoded.
(Tags: Knowledge base)`,
    inputSchema: {"type":"object","properties":{"requestBody":{"type":"object","required":["file","filename"],"properties":{"file":{"type":"string","description":"Base64-encoded file content."},"filename":{"type":"string","description":"Filename including the `.pdf` extension."}},"description":"The JSON request body."}},"required":["requestBody"]},
    method: "post",
    pathTemplate: "/knowledge_base/create",
    executionParameters: [],
    requestBodyContentType: "application/json",
    securityRequirements: [{"BearerAuth":[]}],
    tags: ["Knowledge base"],
    deprecated: false
  }],
  ["attachKnowledgeBaseFiles", {
    name: "attachKnowledgeBaseFiles",
    description: `Attach multiple knowledge-base files to an agent.
(Tags: Knowledge base)`,
    inputSchema: {"type":"object","properties":{"requestBody":{"type":"object","required":["file_ids","agent_id"],"properties":{"file_ids":{"type":"array","minItems":1,"items":{"type":"number"},"description":"List of knowledge-base file IDs to attach."},"agent_id":{"type":"number","description":"ID of the agent to attach files to."},"when_to_use":{"type":"string","description":"Instruction to the agent on when to consult these files."}},"description":"The JSON request body."}},"required":["requestBody"]},
    method: "post",
    pathTemplate: "/knowledge_base/attach",
    executionParameters: [],
    requestBodyContentType: "application/json",
    securityRequirements: [{"BearerAuth":[]}],
    tags: ["Knowledge base"],
    deprecated: false
  }],
  ["detachKnowledgeBaseFiles", {
    name: "detachKnowledgeBaseFiles",
    description: `Detach multiple knowledge-base files from an agent.
(Tags: Knowledge base)`,
    inputSchema: {"type":"object","properties":{"requestBody":{"type":"object","required":["file_ids","agent_id"],"properties":{"file_ids":{"type":"array","minItems":1,"items":{"type":"number"},"description":"List of knowledge-base file IDs to detach."},"agent_id":{"type":"number","description":"ID of the agent to detach files from."}},"description":"The JSON request body."}},"required":["requestBody"]},
    method: "post",
    pathTemplate: "/knowledge_base/detach",
    executionParameters: [],
    requestBodyContentType: "application/json",
    securityRequirements: [{"BearerAuth":[]}],
    tags: ["Knowledge base"],
    deprecated: false
  }],
  ["deleteKnowledgeBaseFile", {
    name: "deleteKnowledgeBaseFile",
    description: `Permanently delete a file. Removes it from any attached agents. Cannot be undone.
(Tags: Knowledge base)`,
    inputSchema: {"type":"object","properties":{"requestBody":{"type":"object","required":["file_id"],"properties":{"file_id":{"type":"number","description":"ID of the file to delete."}},"description":"The JSON request body."}},"required":["requestBody"]},
    method: "post",
    pathTemplate: "/knowledge_base/delete",
    executionParameters: [],
    requestBodyContentType: "application/json",
    securityRequirements: [{"BearerAuth":[]}],
    tags: ["Knowledge base"],
    deprecated: false
  }],
  ["listPhoneNumbers", {
    name: "listPhoneNumbers",
    description: `Retrieve the phone numbers on your account, whether you bought them
from the OmniDimension number shop or imported your own.

(Tags: Phone numbers)`,
    inputSchema: {"type":"object","properties":{"pageno":{"type":"integer","minimum":1,"default":1,"description":"Page number for pagination."},"pagesize":{"type":"integer","minimum":1,"default":30,"maximum":150,"description":"Items per page (max 150)."}}},
    method: "get",
    pathTemplate: "/phone_number/list",
    executionParameters: [{"name":"pageno","in":"query"},{"name":"pagesize","in":"query"}],
    requestBodyContentType: undefined,
    securityRequirements: [{"BearerAuth":[]}],
    tags: ["Phone numbers"],
    deprecated: false
  }],
  ["searchPhoneNumbers", {
    name: "searchPhoneNumbers",
    description: `Search the OmniDimension number shop for phone numbers available to buy
in a region. Price and validity are flat per region, so every result
shows the same \`monthly_rental_usd\` and \`validity_days\`, and that is the
exact amount a purchase will charge.

(Tags: Phone numbers)`,
    inputSchema: {"type":"object","properties":{"region":{"type":"string","enum":["IN","US"],"description":"Region to search in."},"pattern":{"type":"string","description":"Digits or prefix to match within the number."},"page":{"type":"number","minimum":1,"default":1,"description":"Page of results to return."},"limit":{"type":"number","minimum":1,"maximum":150,"default":20,"description":"Results per page."}},"required":["region"]},
    method: "get",
    pathTemplate: "/phone_number/search",
    executionParameters: [{"name":"region","in":"query"},{"name":"pattern","in":"query"},{"name":"page","in":"query"},{"name":"limit","in":"query"}],
    requestBodyContentType: undefined,
    securityRequirements: [{"BearerAuth":[]}],
    tags: ["Phone numbers"],
    deprecated: false
  }],
  ["purchasePhoneNumber", {
    name: "purchasePhoneNumber",
    description: `Buy a phone number from the OmniDimension number shop. The monthly
rental comes out of your wallet and the number is added to your
account, ready to attach to an agent.

(Tags: Phone numbers)`,
    inputSchema: {"type":"object","properties":{"Idempotency-Key":{"type":"string","description":"Your own unique key for this purchase, for example a\nfresh UUID. Strongly recommended: it is what makes a\nretry safe.\n"},"requestBody":{"type":"object","required":["region","phone_number"],"properties":{"region":{"type":"string","enum":["IN","US"],"description":"Region the number belongs to."},"phone_number":{"type":"string","description":"The number to buy, as returned by the search operation."}},"description":"The JSON request body."}},"required":["requestBody"]},
    method: "post",
    pathTemplate: "/phone_number/purchase",
    executionParameters: [{"name":"Idempotency-Key","in":"header"}],
    requestBodyContentType: "application/json",
    securityRequirements: [{"BearerAuth":[]}],
    tags: ["Phone numbers"],
    deprecated: false
  }],
  ["releasePhoneNumber", {
    name: "releasePhoneNumber",
    description: `Give up a phone number and stop its rental, so it is not charged at the
next renewal. Only a number currently allocated to the account can be
released.

(Tags: Phone numbers)`,
    inputSchema: {"type":"object","properties":{"requestBody":{"type":"object","required":["phone_number"],"properties":{"phone_number":{"type":"string","description":"The number to release."}},"description":"The JSON request body."}},"required":["requestBody"]},
    method: "post",
    pathTemplate: "/phone_number/release",
    executionParameters: [],
    requestBodyContentType: "application/json",
    securityRequirements: [{"BearerAuth":[]}],
    tags: ["Phone numbers"],
    deprecated: false
  }],
  ["attachPhoneNumber", {
    name: "attachPhoneNumber",
    description: `Attach an account-owned phone number to an existing agent.
(Tags: Phone numbers)`,
    inputSchema: {"type":"object","properties":{"requestBody":{"type":"object","required":["phone_number_id","agent_id"],"properties":{"phone_number_id":{"type":"number","description":"ID of the phone number to attach."},"agent_id":{"type":"number","description":"ID of the agent to attach the phone number to."}},"description":"The JSON request body."}},"required":["requestBody"]},
    method: "post",
    pathTemplate: "/phone_number/attach",
    executionParameters: [],
    requestBodyContentType: "application/json",
    securityRequirements: [{"BearerAuth":[]}],
    tags: ["Phone numbers"],
    deprecated: false
  }],
  ["detachPhoneNumber", {
    name: "detachPhoneNumber",
    description: `Detach a phone number from its associated agent.
(Tags: Phone numbers)`,
    inputSchema: {"type":"object","properties":{"requestBody":{"type":"object","required":["phone_number_id"],"properties":{"phone_number_id":{"type":"number","description":"ID of the phone number to detach."}},"description":"The JSON request body."}},"required":["requestBody"]},
    method: "post",
    pathTemplate: "/phone_number/detach",
    executionParameters: [],
    requestBodyContentType: "application/json",
    securityRequirements: [{"BearerAuth":[]}],
    tags: ["Phone numbers"],
    deprecated: false
  }],
  ["importTwilioNumber", {
    name: "importTwilioNumber",
    description: `Import an existing Twilio number by providing your Twilio credentials.
(Tags: Phone numbers)`,
    inputSchema: {"type":"object","properties":{"requestBody":{"type":"object","required":["phone_number","account_sid","account_token"],"properties":{"phone_number":{"type":"string","description":"Phone number in E.164 format (starting with `+`)."},"account_sid":{"type":"string","description":"Your Twilio account SID."},"account_token":{"type":"string","description":"Your Twilio auth token."},"name":{"type":"string","description":"Optional friendly name for the imported number."}},"description":"The JSON request body."}},"required":["requestBody"]},
    method: "post",
    pathTemplate: "/phone_number/import/twilio",
    executionParameters: [],
    requestBodyContentType: "application/json",
    securityRequirements: [{"BearerAuth":[]}],
    tags: ["Phone numbers"],
    deprecated: false
  }],
  ["importExotelNumber", {
    name: "importExotelNumber",
    description: `Import an Exotel number by providing your Exotel credentials.
(Tags: Phone numbers)`,
    inputSchema: {"type":"object","properties":{"requestBody":{"type":"object","required":["exotel_phone_number","exotel_api_key","exotel_api_token","exotel_subdomain","exotel_account_sid","exotel_app_id"],"properties":{"exotel_phone_number":{"type":"string","description":"Exotel phone number in E.164 format."},"exotel_api_key":{"type":"string","description":"Your Exotel API key."},"exotel_api_token":{"type":"string","description":"Your Exotel API token."},"exotel_subdomain":{"type":"string","description":"Your Exotel subdomain (e.g. `your-account.in.exotel.com`)."},"exotel_account_sid":{"type":"string","description":"Your Exotel account SID."},"exotel_app_id":{"type":"string","description":"The Exotel App ID configured for the bot."},"name":{"type":"string","description":"Optional friendly name for the imported number."}},"description":"The JSON request body."}},"required":["requestBody"]},
    method: "post",
    pathTemplate: "/phone_number/import/exotel",
    executionParameters: [],
    requestBodyContentType: "application/json",
    securityRequirements: [{"BearerAuth":[]}],
    tags: ["Phone numbers"],
    deprecated: false
  }],
  ["importSipTrunk", {
    name: "importSipTrunk",
    description: `Import a phone number associated with a SIP trunk.
(Tags: Phone numbers)`,
    inputSchema: {"type":"object","properties":{"requestBody":{"type":"object","required":["phone_number","sip_host","sip_trunk_name"],"properties":{"phone_number":{"type":"string","description":"Phone number in E.164 format (starting with `+`)."},"sip_host":{"type":"string","description":"SIP server hostname or IP."},"sip_trunk_name":{"type":"string","description":"Name for this SIP trunk (must be unique within your account)."},"name":{"type":"string","description":"Optional friendly name for the imported number."},"sip_port":{"type":"number","default":5060,"description":"SIP server port."},"sip_username":{"type":"string","description":"SIP authentication username."},"sip_password":{"type":"string","format":"password","description":"SIP authentication password."},"sip_dial_prefix":{"type":"string","description":"Optional prefix to prepend before the destination number when dialing (e.g. to strip the country code)."},"sip_strip_plus":{"type":"boolean","description":"When true, strips the leading `+` from the dialed number."}},"description":"The JSON request body."}},"required":["requestBody"]},
    method: "post",
    pathTemplate: "/phone_number/import/sip",
    executionParameters: [],
    requestBodyContentType: "application/json",
    securityRequirements: [{"BearerAuth":[]}],
    tags: ["Phone numbers"],
    deprecated: false
  }],
  ["listLLMProviders", {
    name: "listLLMProviders",
    description: `Retrieve all available Large Language Model providers.
(Tags: Providers)`,
    inputSchema: {"type":"object","properties":{}},
    method: "get",
    pathTemplate: "/providers/llms",
    executionParameters: [],
    requestBodyContentType: undefined,
    securityRequirements: [{"BearerAuth":[]}],
    tags: ["Providers"],
    deprecated: false
  }],
  ["listVoices", {
    name: "listVoices",
    description: `Retrieve voices with filtering and pagination support. ElevenLabs
supports advanced filtering by name, language, accent, and gender.
Other providers support basic pagination only.

(Tags: Providers)`,
    inputSchema: {"type":"object","properties":{"provider":{"type":"string","enum":["eleven_labs","google","deepgram","cartesia","sarvam"],"description":"TTS provider to list voices from. Omit to list across all providers."},"search":{"type":"string","description":"Substring match against voice name or description. ElevenLabs only."},"language":{"type":"string","description":"ISO language code (e.g. `en`, `hi`, `es`). ElevenLabs only."},"accent":{"type":"string","description":"Accent label (e.g. `american`, `british`). ElevenLabs only."},"gender":{"type":"string","enum":["male","female"],"description":"Filter voices by gender. ElevenLabs only."},"page":{"type":"integer","minimum":1,"default":1,"description":"1-indexed page number."},"page_size":{"type":"integer","minimum":1,"default":30,"maximum":100,"description":"Voices per page. Capped at 100."}}},
    method: "get",
    pathTemplate: "/providers/voices",
    executionParameters: [{"name":"provider","in":"query"},{"name":"search","in":"query"},{"name":"language","in":"query"},{"name":"accent","in":"query"},{"name":"gender","in":"query"},{"name":"page","in":"query"},{"name":"page_size","in":"query"}],
    requestBodyContentType: undefined,
    securityRequirements: [{"BearerAuth":[]}],
    tags: ["Providers"],
    deprecated: false
  }],
  ["listSTTProviders", {
    name: "listSTTProviders",
    description: `Retrieve all Speech-to-Text providers.
(Tags: Providers)`,
    inputSchema: {"type":"object","properties":{}},
    method: "get",
    pathTemplate: "/providers/stt",
    executionParameters: [],
    requestBodyContentType: undefined,
    securityRequirements: [{"BearerAuth":[]}],
    tags: ["Providers"],
    deprecated: false
  }],
  ["listTTSProviders", {
    name: "listTTSProviders",
    description: `Retrieve all Text-to-Speech providers.
(Tags: Providers)`,
    inputSchema: {"type":"object","properties":{}},
    method: "get",
    pathTemplate: "/providers/tts",
    executionParameters: [],
    requestBodyContentType: undefined,
    securityRequirements: [{"BearerAuth":[]}],
    tags: ["Providers"],
    deprecated: false
  }],
  ["listAllProviders", {
    name: "listAllProviders",
    description: `Comprehensive response with services and voices in one payload.
(Tags: Providers)`,
    inputSchema: {"type":"object","properties":{}},
    method: "get",
    pathTemplate: "/providers/all",
    executionParameters: [],
    requestBodyContentType: undefined,
    securityRequirements: [{"BearerAuth":[]}],
    tags: ["Providers"],
    deprecated: false
  }],
  ["getVoice", {
    name: "getVoice",
    description: `Detailed metadata for a specific voice.
(Tags: Providers)`,
    inputSchema: {"type":"object","properties":{"voice_id":{"type":"number","description":"Numeric id of the voice, as returned in the `id` field of the voices list."}},"required":["voice_id"]},
    method: "get",
    pathTemplate: "/providers/voice/{voice_id}",
    executionParameters: [{"name":"voice_id","in":"path"}],
    requestBodyContentType: undefined,
    securityRequirements: [{"BearerAuth":[]}],
    tags: ["Providers"],
    deprecated: false
  }],
]);

/**
 * Security schemes from the OpenAPI spec
 */
const securitySchemes =   {
    "BearerAuth": {
      "type": "http",
      "scheme": "bearer",
      "description": "Bearer token authentication. Obtain your API key from the\nOmniDimension dashboard.\n"
    }
  };


server.setRequestHandler(ListToolsRequestSchema, async () => {
  const toolsForClient: Tool[] = Array.from(toolDefinitionMap.values()).map(def => ({
    name: def.name,
    description: def.description,
    inputSchema: def.inputSchema,
    annotations: toolAnnotations(def)
  }));
  return { tools: toolsForClient };
});


server.setRequestHandler(CallToolRequestSchema, async (request: CallToolRequest): Promise<CallToolResult> => {
  const { name: toolName, arguments: toolArgs } = request.params;
  const toolDefinition = toolDefinitionMap.get(toolName);
  if (!toolDefinition) {
    console.error(`Error: Unknown tool requested: ${toolName}`);
    return { content: [{ type: "text", text: `Error: Unknown tool requested: ${toolName}` }] };
  }
  return await executeApiTool(toolName, toolDefinition, toolArgs ?? {}, securitySchemes);
});



/**
 * Type definition for cached OAuth tokens
 */
interface TokenCacheEntry {
    token: string;
    expiresAt: number;
}

/**
 * Declare global __oauthTokenCache property for TypeScript
 */
declare global {
    var __oauthTokenCache: Record<string, TokenCacheEntry> | undefined;
}

/**
 * Acquires an OAuth2 token using client credentials flow
 * 
 * @param schemeName Name of the security scheme
 * @param scheme OAuth2 security scheme
 * @returns Acquired token or null if unable to acquire
 */
async function acquireOAuth2Token(schemeName: string, scheme: any): Promise<string | null | undefined> {
    try {
        // Check if we have the necessary credentials (resolved per-scheme at runtime)
        const clientId = process.env[`OAUTH_CLIENT_ID_${schemeName.replace(/[^a-zA-Z0-9]/g, '_').toUpperCase()}`];
        const clientSecret = process.env[`OAUTH_CLIENT_SECRET_${schemeName.replace(/[^a-zA-Z0-9]/g, '_').toUpperCase()}`];
        const scopes = process.env[`OAUTH_SCOPES_${schemeName.replace(/[^a-zA-Z0-9]/g, '_').toUpperCase()}`];

        if (!clientId || !clientSecret) {
            console.error(`Missing client credentials for OAuth2 scheme '${schemeName}'`);
            return null;
        }
        
        // Initialize token cache if needed
        if (typeof global.__oauthTokenCache === 'undefined') {
            global.__oauthTokenCache = {};
        }
        
        // Check if we have a cached token
        const cacheKey = `${schemeName}_${clientId}`;
        const cachedToken = global.__oauthTokenCache[cacheKey];
        const now = Date.now();
        
        if (cachedToken && cachedToken.expiresAt > now) {
            console.error(`Using cached OAuth2 token for '${schemeName}' (expires in ${Math.floor((cachedToken.expiresAt - now) / 1000)} seconds)`);
            return cachedToken.token;
        }
        
        // Determine token URL based on flow type
        let tokenUrl = '';
        if (scheme.flows?.clientCredentials?.tokenUrl) {
            tokenUrl = scheme.flows.clientCredentials.tokenUrl;
            console.error(`Using client credentials flow for '${schemeName}'`);
        } else if (scheme.flows?.password?.tokenUrl) {
            tokenUrl = scheme.flows.password.tokenUrl;
            console.error(`Using password flow for '${schemeName}'`);
        } else {
            console.error(`No supported OAuth2 flow found for '${schemeName}'`);
            return null;
        }
        
        // Prepare the token request
        let formData = new URLSearchParams();
        formData.append('grant_type', 'client_credentials');
        
        // Add scopes if specified
        if (scopes) {
            formData.append('scope', scopes);
        }

        console.error(`Requesting OAuth2 token from ${tokenUrl}`);

        // Make the token request
        const response = await axios({
            method: 'POST',
            url: tokenUrl,
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded',
                'Authorization': `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString('base64')}`
            },
            data: formData.toString()
        });
        
        // Process the response
        if (response.data?.access_token) {
            const token = response.data.access_token;
            const expiresIn = response.data.expires_in || 3600; // Default to 1 hour
            
            // Cache the token
            global.__oauthTokenCache[cacheKey] = {
                token,
                expiresAt: now + (expiresIn * 1000) - 60000 // Expire 1 minute early
            };
            
            console.error(`Successfully acquired OAuth2 token for '${schemeName}' (expires in ${expiresIn} seconds)`);
            return token;
        } else {
            console.error(`Failed to acquire OAuth2 token for '${schemeName}': No access_token in response`);
            return null;
        }
    } catch (error: unknown) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        console.error(`Error acquiring OAuth2 token for '${schemeName}':`, errorMessage);
        return null;
    }
}


/**
 * Executes an API tool with the provided arguments
 * 
 * @param toolName Name of the tool to execute
 * @param definition Tool definition
 * @param toolArgs Arguments provided by the user
 * @param allSecuritySchemes Security schemes from the OpenAPI spec
 * @returns Call tool result
 */
async function executeApiTool(
    toolName: string,
    definition: McpToolDefinition,
    toolArgs: JsonObject,
    allSecuritySchemes: Record<string, any>
): Promise<CallToolResult> {
  try {
    // Validate arguments against the input schema
    let validatedArgs: JsonObject;
    try {
        const zodSchema = getZodSchemaFromJsonSchema(definition.inputSchema, toolName);
        const argsToParse = (typeof toolArgs === 'object' && toolArgs !== null) ? toolArgs : {};
        validatedArgs = zodSchema.parse(argsToParse);
    } catch (error: unknown) {
        recordToolResult(toolName, 'validation');
        if (error instanceof ZodError) {
            const validationErrorMessage = `Invalid arguments for tool '${toolName}': ${error.errors.map(e => `${e.path.join('.')} (${e.code}): ${e.message}`).join(', ')}`;
            return { isError: true, content: [{ type: 'text', text: validationErrorMessage }] };
        } else {
             const errorMessage = error instanceof Error ? error.message : String(error);
             return { isError: true, content: [{ type: 'text', text: `Internal error during validation setup: ${errorMessage}` }] };
        }
    }

    // Prepare URL, query parameters, headers, and request body
    let urlPath = definition.pathTemplate;
    const queryParams: Record<string, any> = {};
    const headers: Record<string, string> = { 'Accept': 'application/json' };
    let requestBodyData: any = undefined;

    // Apply parameters to the URL path, query, or headers
    definition.executionParameters.forEach((param) => {
        const value = validatedArgs[param.name];
        if (typeof value !== 'undefined' && value !== null) {
            if (param.in === 'path') {
                urlPath = urlPath.replace(`{${param.name}}`, encodeURIComponent(String(value)));
            }
            else if (param.in === 'query') {
                queryParams[param.name] = value;
            }
            else if (param.in === 'header') {
                headers[param.name.toLowerCase()] = String(value);
            }
        }
    });

    // Ensure all path parameters are resolved
    if (urlPath.includes('{')) {
        throw new Error(`Failed to resolve path parameters: ${urlPath}`);
    }
    
    // Construct the full URL
    const requestUrl = API_BASE_URL ? `${API_BASE_URL}${urlPath}` : urlPath;

    // Handle request body if needed
    if (definition.requestBodyContentType && typeof validatedArgs['requestBody'] !== 'undefined') {
        requestBodyData = validatedArgs['requestBody'];
        headers['content-type'] = definition.requestBodyContentType;
    }

    // Apply security requirements if available
    // Security requirements use OR between array items and AND within each object
    const appliedSecurity = definition.securityRequirements?.find(req => {
        // Try each security requirement (combined with OR)
        return Object.entries(req).every(([schemeName, scopesArray]) => {
            const scheme = allSecuritySchemes[schemeName];
            if (!scheme) return false;
            
            // API Key security (header, query, cookie)
            if (scheme.type === 'apiKey') {
                return !!process.env[`API_KEY_${schemeName.replace(/[^a-zA-Z0-9]/g, '_').toUpperCase()}`];
            }
            
            // HTTP security (basic, bearer)
            if (scheme.type === 'http') {
                if (scheme.scheme?.toLowerCase() === 'bearer') {
                    return !!(process.env.OMNIDIM_API_KEY || readApiKey() || process.env[`BEARER_TOKEN_${schemeName.replace(/[^a-zA-Z0-9]/g, '_').toUpperCase()}`]);
                }
                else if (scheme.scheme?.toLowerCase() === 'basic') {
                    // Username is sufficient; an empty password is valid per RFC 7617 (issue #66)
                    return process.env[`BASIC_USERNAME_${schemeName.replace(/[^a-zA-Z0-9]/g, '_').toUpperCase()}`] != null;
                }
            }
            
            // OAuth2 security
            if (scheme.type === 'oauth2') {
                // Check for pre-existing token
                if (process.env[`OAUTH_TOKEN_${schemeName.replace(/[^a-zA-Z0-9]/g, '_').toUpperCase()}`]) {
                    return true;
                }
                
                // Check for client credentials for auto-acquisition
                if (process.env[`OAUTH_CLIENT_ID_${schemeName.replace(/[^a-zA-Z0-9]/g, '_').toUpperCase()}`] &&
                    process.env[`OAUTH_CLIENT_SECRET_${schemeName.replace(/[^a-zA-Z0-9]/g, '_').toUpperCase()}`]) {
                    // Verify we have a supported flow
                    if (scheme.flows?.clientCredentials || scheme.flows?.password) {
                        return true;
                    }
                }
                
                return false;
            }
            
            // OpenID Connect
            if (scheme.type === 'openIdConnect') {
                return !!process.env[`OPENID_TOKEN_${schemeName.replace(/[^a-zA-Z0-9]/g, '_').toUpperCase()}`];
            }
            
            return false;
        });
    });

    // If we found matching security scheme(s), apply them
    if (appliedSecurity) {
        // Apply each security scheme from this requirement (combined with AND)
        for (const [schemeName, scopesArray] of Object.entries(appliedSecurity)) {
            const scheme = allSecuritySchemes[schemeName];
            
            // API Key security
            if (scheme?.type === 'apiKey') {
                const apiKey = process.env[`API_KEY_${schemeName.replace(/[^a-zA-Z0-9]/g, '_').toUpperCase()}`];
                if (apiKey) {
                    if (scheme.in === 'header') {
                        headers[scheme.name.toLowerCase()] = apiKey;
                        if (process.env.OMNIDIM_DEBUG) console.error(`Applied API key '${schemeName}' in header '${scheme.name}'`);
                    }
                    else if (scheme.in === 'query') {
                        queryParams[scheme.name] = apiKey;
                        if (process.env.OMNIDIM_DEBUG) console.error(`Applied API key '${schemeName}' in query parameter '${scheme.name}'`);
                    }
                    else if (scheme.in === 'cookie') {
                        // Add the cookie, preserving other cookies if they exist
                        headers['cookie'] = `${scheme.name}=${apiKey}${headers['cookie'] ? `; ${headers['cookie']}` : ''}`;
                        if (process.env.OMNIDIM_DEBUG) console.error(`Applied API key '${schemeName}' in cookie '${scheme.name}'`);
                    }
                }
            } 
            // HTTP security (Bearer or Basic)
            else if (scheme?.type === 'http') {
                if (scheme.scheme?.toLowerCase() === 'bearer') {
                    const token = process.env.OMNIDIM_API_KEY || readApiKey() || process.env[`BEARER_TOKEN_${schemeName.replace(/[^a-zA-Z0-9]/g, '_').toUpperCase()}`];
                    if (token) {
                        headers['authorization'] = `Bearer ${token}`;
                        if (process.env.OMNIDIM_DEBUG) console.error(`Applied Bearer token for '${schemeName}'`);
                    }
                } 
                else if (scheme.scheme?.toLowerCase() === 'basic') {
                    const username = process.env[`BASIC_USERNAME_${schemeName.replace(/[^a-zA-Z0-9]/g, '_').toUpperCase()}`];
                    const password = process.env[`BASIC_PASSWORD_${schemeName.replace(/[^a-zA-Z0-9]/g, '_').toUpperCase()}`];
                    // Empty password is valid per RFC 7617 (issue #66); only username is required.
                    if (username != null) {
                        headers['authorization'] = `Basic ${Buffer.from(`${username}:${password ?? ''}`).toString('base64')}`;
                        if (process.env.OMNIDIM_DEBUG) console.error(`Applied Basic authentication for '${schemeName}'`);
                    }
                }
            }
            // OAuth2 security
            else if (scheme?.type === 'oauth2') {
                // First try to use a pre-provided token
                let token = process.env[`OAUTH_TOKEN_${schemeName.replace(/[^a-zA-Z0-9]/g, '_').toUpperCase()}`];
                
                // If no token but we have client credentials, try to acquire a token
                if (!token && (scheme.flows?.clientCredentials || scheme.flows?.password)) {
                    console.error(`Attempting to acquire OAuth token for '${schemeName}'`);
                    token = (await acquireOAuth2Token(schemeName, scheme)) ?? '';
                }
                
                // Apply token if available
                if (token) {
                    headers['authorization'] = `Bearer ${token}`;
                    if (process.env.OMNIDIM_DEBUG) console.error(`Applied OAuth2 token for '${schemeName}'`);
                    
                    // List the scopes that were requested, if any
                    const scopes = scopesArray as string[];
                    if (scopes && scopes.length > 0) {
                        console.error(`Requested scopes: ${scopes.join(', ')}`);
                    }
                }
            }
            // OpenID Connect
            else if (scheme?.type === 'openIdConnect') {
                const token = process.env[`OPENID_TOKEN_${schemeName.replace(/[^a-zA-Z0-9]/g, '_').toUpperCase()}`];
                if (token) {
                    headers['authorization'] = `Bearer ${token}`;
                    if (process.env.OMNIDIM_DEBUG) console.error(`Applied OpenID Connect token for '${schemeName}'`);
                    
                    // List the scopes that were requested, if any
                    const scopes = scopesArray as string[];
                    if (scopes && scopes.length > 0) {
                        console.error(`Requested scopes: ${scopes.join(', ')}`);
                    }
                }
            }
        }
    } 
    else if (definition.securityRequirements?.length > 0) {
        recordToolResult(toolName, 'no_api_key');
        return {
            isError: true,
            content: [{
                type: 'text',
                text: `OMNIDIM_API_KEY is not set. Configure it in your MCP client's "env" block, then restart the client. Get a key at https://omnidim.io/api-management.`,
            }],
        };
    }
    

    // Prepare the axios request configuration
    const config: AxiosRequestConfig = {
      method: definition.method.toUpperCase(),
      url: requestUrl,
      params: queryParams,
      headers: headers,
      // Serialize array query params as comma-separated values (issue #41)
      paramsSerializer: (params: Record<string, any>) => {
        const search = new URLSearchParams();
        for (const [key, value] of Object.entries(params)) {
          if (value === undefined || value === null) continue;
          search.append(key, Array.isArray(value) ? value.join(',') : String(value));
        }
        return search.toString();
      },
      ...(requestBodyData !== undefined && { data: requestBodyData }),
    };

    if (process.env.OMNIDIM_DEBUG) {
        console.error(`Executing tool "${toolName}": ${config.method} ${config.url}`);
    }

    // Execute the request
    const response = await axios(config);

    // Process and format the response
    let responseText = '';
    // Coerce header value to string before lowercasing (issue #65)
    const contentType = String(response.headers['content-type'] ?? '').toLowerCase();
    
    // Handle JSON responses
    if (contentType.includes('application/json') && typeof response.data === 'object' && response.data !== null) {
         try {
             const trimmed = trimLargeResponse(response.data);
             responseText = trimmed.text;
             if (trimmed.note) responseText += `\n\n${trimmed.note}`;
         } catch (e) { 
             responseText = "[Stringify Error]"; 
         }
    } 
    // The backend returns an HTML 404 page (not JSON) when a path
    // converter rejects an input (e.g. GET /agents/abc).
    else if (contentType.includes('text/html')) {
         const title = typeof response.data === 'string'
             ? (response.data.match(/<title>([^<]*)<\/title>/i)?.[1]?.trim() ?? 'HTML response')
             : 'HTML response';
         responseText = `Upstream returned HTML instead of JSON (HTTP ${response.status}: "${title}"). The path or method is likely wrong.`;
    }
    else if (typeof response.data === 'string') {
         responseText = response.data;
    }
    // Handle other response types
    else if (response.data !== undefined && response.data !== null) { 
         responseText = String(response.data); 
    }
    // Handle empty responses
    else { 
         responseText = `(Status: ${response.status} - No body content)`; 
    }
    
    // Return formatted response
    recordToolResult(toolName, 'ok');
    return { 
        content: [ 
            { 
                type: "text", 
                text: `API Response (Status: ${response.status}):\n${responseText}` 
            } 
        ], 
    };

  } catch (error: unknown) {
    recordToolError(toolName, error);
    // Handle errors during execution
    let errorMessage: string;
    
    // Format Axios errors specially
    if (axios.isAxiosError(error)) { 
        errorMessage = formatApiError(error); 
    }
    // Handle standard errors
    else if (error instanceof Error) { 
        errorMessage = error.message; 
    }
    // Handle unexpected error types
    else { 
        errorMessage = 'Unexpected error: ' + String(error); 
    }
    
    // Log error to stderr
    console.error(`Error during execution of tool '${toolName}':`, errorMessage);
    
    // Return error message to client
    return { isError: true, content: [{ type: "text", text: errorMessage }] };
  }
}


/**
 * Main function to start the server
 */
async function main() {
  if (process.argv[2] === "setup") {
    const { runSetup } = await import("./setup.js");
    process.exit(await runSetup());
  }
  if (process.argv[2] === "telemetry") {
    const { runTelemetryCommand } = await import("./telemetry-cli.js");
    process.exit(await runTelemetryCommand(process.argv[3]));
  }
  if (process.argv[2] === "doctor") {
    const { runDoctor } = await import("./doctor.js");
    process.exit(await runDoctor());
  }
  if (isInteractive()) {
    printInteractiveHelp(SERVER_VERSION);
    process.exit(0);
  }
  try {
    const transport = new StdioServerTransport();
    await server.connect(transport);
    console.error(startupBanner(SERVER_VERSION, toolDefinitionMap.size));
    beginSession();
    notifyUpdates(SERVER_VERSION);
  } catch (error) {
    try { await emitSessionCrash(error); } catch { /* telemetry must never mask the crash */ }
    console.error("Error during server startup:", error);
    process.exit(1);
  }
}

/**
 * Cleanup function for graceful shutdown
 */
async function cleanup() {
    try {
        await emitSessionEnd(endSession());
    } catch {
        // telemetry must never block shutdown
    }
    console.error("Shutting down MCP server...");
    process.exit(0);
}

// Register signal handlers
process.on('SIGINT', cleanup);
process.on('SIGTERM', cleanup);

process.on('uncaughtException', async (error) => {
    try { await emitSessionCrash(error); } catch { /* never mask the crash */ }
    console.error("Uncaught exception:", error);
    process.exit(1);
});
process.on('unhandledRejection', async (reason) => {
    try { await emitSessionCrash(reason); } catch { /* never mask the crash */ }
    console.error("Unhandled rejection:", reason);
    process.exit(1);
});

// Start the server
main().catch(async (error) => {
  try { await emitSessionCrash(error); } catch { /* never mask the crash */ }
  console.error("Fatal error in main execution:", error);
  process.exit(1);
});

/**
 * Formats API errors for better readability
 * 
 * @param error Axios error
 * @returns Formatted error message
 */
function formatApiError(error: AxiosError): string {
    let message = 'API request failed.';
    if (error.response) {
        message = `API Error: Status ${error.response.status} (${error.response.statusText || 'Status text not available'}). `;
        const responseData = error.response.data;
        const MAX_LEN = 200;
        if (typeof responseData === 'string') { 
            message += `Response: ${responseData.substring(0, MAX_LEN)}${responseData.length > MAX_LEN ? '...' : ''}`; 
        }
        else if (responseData) { 
            try { 
                const jsonString = JSON.stringify(responseData); 
                message += `Response: ${jsonString.substring(0, MAX_LEN)}${jsonString.length > MAX_LEN ? '...' : ''}`; 
            } catch { 
                message += 'Response: [Could not serialize data]'; 
            } 
        }
        else { 
            message += 'No response body received.'; 
        }
    } else if (error.request) {
        message = 'API Network Error: No response received from server.';
        if (error.code) message += ` (Code: ${error.code})`;
    } else { 
        message += `API Request Setup Error: ${error.message}`; 
    }
    return message;
}

/**
 * Converts a JSON Schema to a Zod schema for runtime validation
 * 
 * @param jsonSchema JSON Schema
 * @param toolName Tool name for error reporting
 * @returns Zod schema
 */
const zodSchemaCache: Map<string, z.ZodTypeAny> = new Map();
function getZodSchemaFromJsonSchema(jsonSchema: any, toolName: string): z.ZodTypeAny {
    const cached = zodSchemaCache.get(toolName);
    if (cached) return cached;
    if (typeof jsonSchema !== 'object' || jsonSchema === null) {
        const fallback = z.object({}).passthrough();
        zodSchemaCache.set(toolName, fallback);
        return fallback;
    }
    try {
        const body = jsonSchemaToZod(jsonSchema);
        const factory = new Function('z', `return (${body});`) as (z: any) => z.ZodTypeAny;
        const schema = factory(z);
        if (typeof (schema as any)?.parse !== 'function') {
            throw new Error('Schema factory did not produce a valid Zod schema.');
        }
        zodSchemaCache.set(toolName, schema);
        return schema;
    } catch (err: any) {
        console.error(`Failed to generate Zod schema for '${toolName}':`, err);
        const fallback = z.object({}).passthrough();
        zodSchemaCache.set(toolName, fallback);
        return fallback;
    }
}
