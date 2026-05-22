#!/usr/bin/env node
/**
 * OmniDimension MCP server.
 */
import { trimLargeResponse } from "./helpers.js";


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
}

/**
 * Server configuration
 */
export const SERVER_NAME = "OmniDimension";
export const SERVER_VERSION = "0.1.0";
// Base URL for the API, can be set via environment variable or determined from OpenAPI spec
export const API_BASE_URL = process.env.API_BASE_URL || "https://backend.omnidim.io/api/v1";
if (process.env.API_BASE_URL) {
    console.error(`API_BASE_URL override: ${API_BASE_URL}`);
}

/**
 * MCP Server instance
 */
const server = new Server(
    { name: SERVER_NAME, version: SERVER_VERSION },
    { capabilities: { tools: {} } }
);

/**
 * Map of tool definitions by name
 */
const toolDefinitionMap: Map<string, McpToolDefinition> = new Map([

  ["listAgents", {
    name: "listAgents",
    description: `Retrieve all agents for the authenticated user with pagination support.`,
    inputSchema: {"type":"object","properties":{"pageno":{"type":"integer","minimum":1,"default":1,"description":"Page number for pagination."},"pagesize":{"type":"integer","minimum":1,"default":30,"maximum":150,"description":"Number of items per page (max 150)."},"name":{"type":"string","description":"Filter agents whose name matches this substring (case-insensitive)."}}},
    method: "get",
    pathTemplate: "/agents",
    executionParameters: [{"name":"pageno","in":"query"},{"name":"pagesize","in":"query"},{"name":"name","in":"query"}],
    requestBodyContentType: undefined,
    securityRequirements: [{"BearerAuth":[]}]
  }],
  ["createAgent", {
    name: "createAgent",
    description: `Create a new agent with the provided configuration. The full
config supports transcriber, model, voice, web search, transfer,
end-call conditions, post-call actions (email + webhook),
ambient background track, initial ringing sound, and multilingual support.
`,
    inputSchema: {"type":"object","properties":{"requestBody":{"allOf":[{"type":"object","description":"Agent configuration.","properties":{"name":{"type":"string","description":"Name for the agent.","example":"Customer Support Agent"},"welcome_message":{"type":"string","description":"Initial message the agent will say when answering a call.","example":"Hello! How can I help you today?"},"is_welcome_message_interruption":{"type":"boolean","description":"Allow the caller to interrupt the welcome message. When false, the agent finishes speaking the welcome before listening."},"is_interruption_allowed":{"type":"boolean","description":"Global toggle for whether the caller can interrupt the agent mid-sentence at any point in the call."},"dynamic_variables":{"type":"object","description":"Key/value map used to substitute placeholders in the agent's\nprompt and welcome message at call time. Reference a variable\nin your prompt with `{{variable_name}}`. Useful for\npersonalising the same agent across many calls.\n","additionalProperties":{"type":"string"},"example":{"customer_name":"Jane Doe","order_id":"ORD-12345"}},"context_breakdown":{"type":"array","description":"List of context breakdowns, each containing `title`, `body`, and optional `is_enabled`.","items":{"type":"object","required":["title","body"],"properties":{"title":{"type":"string","description":"Title of the breakdown.","example":"Purpose"},"body":{"type":"string","description":"Body of the breakdown — the detailed prompt content.","example":"This agent helps customers with product inquiries and support issues."},"is_enabled":{"type":"boolean","default":true,"description":"Whether this section is included in the prompt."}}}},"call_type":{"type":"string","enum":["Incoming","Outgoing"],"description":"Call type of the assistant."},"transcriber":{"type":"object","description":"Configuration for the speech-to-text transcriber.","properties":{"provider":{"type":"string","enum":["deepgram_stream","cartesia","sarvam","azure_stream","soniox"],"description":"The speech-to-text provider to use.","example":"deepgram_stream"},"model":{"type":"string","enum":["nova-3","nova-2"],"description":"The model to use for transcription (required when provider is `deepgram_stream`).","example":"nova-3"},"language":{"type":"string","description":"Language code for the transcriber. Format and supported\nvalues depend on the provider (e.g. `en-US` for Deepgram,\n`hi-IN` for Sarvam). Applies regardless of which\n`provider` is selected.\n","example":"en-US"},"silence_timeout_ms":{"type":"integer","description":"Silence timeout in milliseconds.","example":400},"should_apply_noise_reduction":{"type":"boolean","description":"Reduce background noise on the inbound audio stream before transcription."},"interruption_min_words":{"type":"integer","minimum":1,"description":"Minimum number of words the caller must say before their speech is treated as an interruption.","example":2},"max_call_duration_in_sec":{"type":"integer","minimum":1,"description":"Hard upper bound on call length in seconds. The agent will end the call once this is reached.","example":600},"first_ideal_message":{"type":"string","description":"First nudge spoken when the caller goes silent past the\nidle threshold. Set `is_first_ideal_message_dynamic` to\n`true` to have the LLM regenerate this each time.\n"},"is_first_ideal_message_dynamic":{"type":"boolean","description":"When true, `first_ideal_message` is treated as a prompt and the LLM generates a fresh nudge each call."},"second_ideal_message":{"type":"string","description":"Second nudge spoken if silence continues after the first."},"is_second_ideal_message_dynamic":{"type":"boolean","description":"When true, `second_ideal_message` is treated as a prompt and the LLM generates a fresh nudge each call."},"numerals":{"type":"boolean","description":"Convert numbers from words to digits."},"punctuate":{"type":"boolean","description":"Add punctuation to the transcript."},"smart_format":{"type":"boolean","description":"Apply smart formatting to the transcript."},"diarize":{"type":"boolean","description":"Identify different speakers in the transcript."}}},"model":{"type":"object","description":"Configuration for the language model.","properties":{"model":{"type":"string","enum":["azure-gpt-4.1-mini","azure-gpt-4.1-nano","azure-gpt-4o","azure-gpt-4o-mini","claude-3-5-haiku-latest","claude-3-5-sonnet-latest","claude-3-7-sonnet-latest","claude-3-opus-latest","claude-opus-4-0","claude-sonnet-4-0","gemini-1.5-pro","gemini-2.0-flash","gemini-2.5-flash","gemini-2.5-flash-lite","gemini-2.5-pro","gemini-3-flash-preview","gemini-3-pro-preview","gemma2-9b-it","gpt-3.5-turbo","gpt-4o","gpt-4o-mini","gpt-5.4","llama-3.3-70b-versatile","llama3-70b-8192","llama3-8b-8192"],"description":"The language model to use.","example":"gpt-4o-mini"},"temperature":{"type":"number","minimum":0,"maximum":1,"description":"Controls randomness in the model's output (0.0 to 1.0).","example":0.7}}},"voice":{"type":"object","description":"Configuration for the text-to-speech voice.","properties":{"provider":{"type":"string","enum":["eleven_labs","deepgram","google","cartesia","rime"],"description":"The voice provider to use.","example":"eleven_labs"},"voice_id":{"type":"string","description":"The specific external voice identifier from the provider.","example":"JBFqnCBsd6RMkjVDRZzb"},"model":{"type":"string","description":"TTS model identifier. Only consumed when `provider` is\n`cartesia` (e.g. `sonic-3.5`). For ElevenLabs and other\nproviders the model is implied by `voice_id` and this\nfield is ignored.\n","example":"sonic-3.5"},"speech_speed":{"type":"number","minimum":0.5,"maximum":2,"default":1,"description":"Playback speed multiplier for the agent's voice. 1.0 is normal speed."}}},"web_search":{"type":"object","description":"Configuration for web search capabilities.","properties":{"enabled":{"type":"boolean","description":"Enable or disable web search functionality."},"provider":{"type":"string","enum":["DuckDuckGo"],"description":"The search provider to use.","example":"DuckDuckGo"}}},"post_call_actions":{"type":"object","description":"Side effects that fire once the call ends. Configure email, webhook, or both.","properties":{"email":{"type":"object","properties":{"enabled":{"type":"boolean"},"recipients":{"type":"array","description":"Email addresses that should receive the notification.","items":{"type":"string","format":"email"},"example":["support@example.com"]},"include":{"type":"array","description":"Which sections to include in the email body.","items":{"type":"string","enum":["summary","extracted_variables","fullConversation","sentiment"]}},"extracted_variables":{"type":"array","description":"Variables the model should pull out of the conversation for the email.","items":{"type":"object","required":["key","prompt"],"properties":{"key":{"type":"string","description":"Unique identifier for the variable in the post-call payload.","example":"customer_issue"},"prompt":{"type":"string","description":"Instruction for the model on what to pull out of the conversation.","example":"Identify the main issue the customer is experiencing."}}}},"trigger_call_statuses":{"type":"array","description":"Call outcomes that should fire this action. Omit to\nuse the default (`completed`, `voicemail_detected`).\nPass an explicit list to also include failed calls,\nno-answers, busy signals, etc.\n","items":{"type":"string","enum":["completed","voicemail_detected","failed","no_answer","busy","cancelled"]},"example":["completed","voicemail_detected"]}}},"webhook":{"type":"object","properties":{"enabled":{"type":"boolean"},"url":{"type":"string","format":"uri","description":"Endpoint that receives a POST with the call payload.","example":"https://your-webhook-endpoint.com/omnidim-callback"},"include":{"type":"array","description":"Which sections to include in the webhook body.","items":{"type":"string","enum":["summary","extracted_variables","fullConversation","sentiment"]}},"extracted_variables":{"type":"array","description":"Variables the model should pull out of the conversation for the webhook.","items":{"type":"object","required":["key","prompt"],"properties":{"key":{"type":"string","description":"Unique identifier for the variable in the post-call payload.","example":"customer_issue"},"prompt":{"type":"string","description":"Instruction for the model on what to pull out of the conversation.","example":"Identify the main issue the customer is experiencing."}}}},"trigger_call_statuses":{"type":"array","description":"Call outcomes that should fire this webhook. Omit to\nuse the default (`completed`, `voicemail_detected`).\n","items":{"type":"string","enum":["completed","voicemail_detected","failed","no_answer","busy","cancelled"]},"example":["completed","failed"]}}}}},"transfer":{"type":"object","description":"Conditional call transfer to a human agent or another number.","properties":{"enabled":{"type":"boolean"},"transfer_options":{"type":"array","description":"Where to transfer the call and under what condition. The first matching condition wins.","items":{"type":"object","required":["number","transfer_condition","transfer_message"],"properties":{"number":{"type":"string","description":"Primary phone number to transfer to. Include country code with leading `+`.","example":"+15551234567"},"type":{"type":"string","enum":["static","dynamic"],"default":"static","description":"`static` transfers to `number`. `dynamic` lets the agent\npick a number at runtime based on the conversation.\n"},"backup_numbers":{"type":"array","description":"Fallback numbers tried if the primary is unreachable.","items":{"type":"string"}},"transfer_condition":{"type":"string","description":"Natural-language condition that triggers this transfer option.","example":"Transfer if the customer asks to speak with a human."},"transfer_message":{"type":"string","description":"Message the agent says to the caller before executing the transfer.","example":"Please hold while I connect you to one of our agents."}}}}}},"end_call":{"type":"object","description":"Hang up automatically when a condition is met.","properties":{"enabled":{"type":"boolean"},"condition":{"type":"string","description":"Natural-language condition that triggers ending the call. Only evaluated when `enabled` is true.","example":"End the call once the customer's issue is resolved."},"message":{"type":"string","description":"What the agent says before hanging up.","example":"Thank you for contacting us. Have a great day!"},"message_type":{"type":"string","enum":["static","prompt"],"description":"`static` speaks `message` verbatim. `prompt` treats\n`message_prompt` as an LLM instruction and generates a\nfresh closing line each call (useful for matching the\ncaller's language and tone).\n"},"message_prompt":{"type":"string","description":"LLM prompt used to generate the closing line when `message_type` is `prompt`.","example":"End the call politely in the same language the user is speaking."}}},"background_track":{"type":"object","description":"Ambient background noise that plays under the agent's voice.","properties":{"enabled":{"type":"boolean","description":"Whether to mix the ambient track under the agent's audio."},"name":{"type":"string","enum":["call_center","filler","office","office_1","restaurant"],"description":"Ambient track to mix under the agent."},"volume":{"type":"number","minimum":0,"maximum":1,"default":0.2,"description":"Volume level on a 0–1 scale. Default 0.2."},"tts_volume_reduction":{"type":"number","minimum":0,"maximum":1,"description":"Amount to drop the agent's TTS volume while the ambient track plays, on a 0–1 scale. Helps the voice cut through without raising the overall mix."}}},"initial_ringing_sound_enabled":{"type":"boolean","description":"Plays a ringing tone after the call is picked up, until the agent starts speaking."},"voicemail":{"type":"object","description":"Voicemail / answering-machine handling for outbound calls.","properties":{"enabled":{"type":"boolean","description":"Detect voicemail and react instead of speaking to a machine."},"message":{"type":"string","description":"Message to leave when voicemail is detected."}}},"languages":{"type":"array","description":"Languages the agent should support. Pass each language as a display-name string.","items":{"type":"string","enum":["English","English (India)","English (US)","Hindi","Bengali","Spanish","Tamil","Marathi","Telugu","Gujarati","French"]},"example":["English","Hindi"]}}},{"type":"object","required":["name","welcome_message","context_breakdown"]}],"description":"The JSON request body."}},"required":["requestBody"]},
    method: "post",
    pathTemplate: "/agents/create",
    executionParameters: [],
    requestBodyContentType: "application/json",
    securityRequirements: [{"BearerAuth":[]}]
  }],
  ["getAgent", {
    name: "getAgent",
    description: `Get details of a specific agent by ID.`,
    inputSchema: {"type":"object","properties":{"agent_id":{"type":"number","description":"The ID of the agent."}},"required":["agent_id"]},
    method: "get",
    pathTemplate: "/agents/{agent_id}",
    executionParameters: [{"name":"agent_id","in":"path"}],
    requestBodyContentType: undefined,
    securityRequirements: [{"BearerAuth":[]}]
  }],
  ["updateAgent", {
    name: "updateAgent",
    description: `Update an existing agent. Send only the fields you want to change.`,
    inputSchema: {"type":"object","properties":{"agent_id":{"type":"number","description":"The ID of the agent."},"requestBody":{"type":"object","description":"Agent configuration.","properties":{"name":{"type":"string","description":"Name for the agent."},"welcome_message":{"type":"string","description":"Initial message the agent will say when answering a call."},"is_welcome_message_interruption":{"type":"boolean","description":"Allow the caller to interrupt the welcome message. When false, the agent finishes speaking the welcome before listening."},"is_interruption_allowed":{"type":"boolean","description":"Global toggle for whether the caller can interrupt the agent mid-sentence at any point in the call."},"dynamic_variables":{"type":"object","description":"Key/value map used to substitute placeholders in the agent's\nprompt and welcome message at call time. Reference a variable\nin your prompt with `{{variable_name}}`. Useful for\npersonalising the same agent across many calls.\n","additionalProperties":{"type":"string"}},"context_breakdown":{"type":"array","description":"List of context breakdowns, each containing `title`, `body`, and optional `is_enabled`.","items":{"type":"object","required":["title","body"],"properties":{"title":{"type":"string","description":"Title of the breakdown."},"body":{"type":"string","description":"Body of the breakdown — the detailed prompt content."},"is_enabled":{"type":"boolean","default":true,"description":"Whether this section is included in the prompt."}}}},"call_type":{"type":"string","enum":["Incoming","Outgoing"],"description":"Call type of the assistant."},"transcriber":{"type":"object","description":"Configuration for the speech-to-text transcriber.","properties":{"provider":{"type":"string","enum":["deepgram_stream","cartesia","sarvam","azure_stream","soniox"],"description":"The speech-to-text provider to use."},"model":{"type":"string","enum":["nova-3","nova-2"],"description":"The model to use for transcription (required when provider is `deepgram_stream`)."},"language":{"type":"string","description":"Language code for the transcriber. Format and supported\nvalues depend on the provider (e.g. `en-US` for Deepgram,\n`hi-IN` for Sarvam). Applies regardless of which\n`provider` is selected.\n"},"silence_timeout_ms":{"type":"number","description":"Silence timeout in milliseconds."},"should_apply_noise_reduction":{"type":"boolean","description":"Reduce background noise on the inbound audio stream before transcription."},"interruption_min_words":{"type":"number","minimum":1,"description":"Minimum number of words the caller must say before their speech is treated as an interruption."},"max_call_duration_in_sec":{"type":"number","minimum":1,"description":"Hard upper bound on call length in seconds. The agent will end the call once this is reached."},"first_ideal_message":{"type":"string","description":"First nudge spoken when the caller goes silent past the\nidle threshold. Set `is_first_ideal_message_dynamic` to\n`true` to have the LLM regenerate this each time.\n"},"is_first_ideal_message_dynamic":{"type":"boolean","description":"When true, `first_ideal_message` is treated as a prompt and the LLM generates a fresh nudge each call."},"second_ideal_message":{"type":"string","description":"Second nudge spoken if silence continues after the first."},"is_second_ideal_message_dynamic":{"type":"boolean","description":"When true, `second_ideal_message` is treated as a prompt and the LLM generates a fresh nudge each call."},"numerals":{"type":"boolean","description":"Convert numbers from words to digits."},"punctuate":{"type":"boolean","description":"Add punctuation to the transcript."},"smart_format":{"type":"boolean","description":"Apply smart formatting to the transcript."},"diarize":{"type":"boolean","description":"Identify different speakers in the transcript."}}},"model":{"type":"object","description":"Configuration for the language model.","properties":{"model":{"type":"string","enum":["azure-gpt-4.1-mini","azure-gpt-4.1-nano","azure-gpt-4o","azure-gpt-4o-mini","claude-3-5-haiku-latest","claude-3-5-sonnet-latest","claude-3-7-sonnet-latest","claude-3-opus-latest","claude-opus-4-0","claude-sonnet-4-0","gemini-1.5-pro","gemini-2.0-flash","gemini-2.5-flash","gemini-2.5-flash-lite","gemini-2.5-pro","gemini-3-flash-preview","gemini-3-pro-preview","gemma2-9b-it","gpt-3.5-turbo","gpt-4o","gpt-4o-mini","gpt-5.4","llama-3.3-70b-versatile","llama3-70b-8192","llama3-8b-8192"],"description":"The language model to use."},"temperature":{"type":"number","minimum":0,"maximum":1,"description":"Controls randomness in the model's output (0.0 to 1.0)."}}},"voice":{"type":"object","description":"Configuration for the text-to-speech voice.","properties":{"provider":{"type":"string","enum":["eleven_labs","deepgram","google","cartesia","rime"],"description":"The voice provider to use."},"voice_id":{"type":"string","description":"The specific external voice identifier from the provider."},"model":{"type":"string","description":"TTS model identifier. Only consumed when `provider` is\n`cartesia` (e.g. `sonic-3.5`). For ElevenLabs and other\nproviders the model is implied by `voice_id` and this\nfield is ignored.\n"},"speech_speed":{"type":"number","minimum":0.5,"maximum":2,"default":1,"description":"Playback speed multiplier for the agent's voice. 1.0 is normal speed."}}},"web_search":{"type":"object","description":"Configuration for web search capabilities.","properties":{"enabled":{"type":"boolean","description":"Enable or disable web search functionality."},"provider":{"type":"string","enum":["DuckDuckGo"],"description":"The search provider to use."}}},"post_call_actions":{"type":"object","description":"Side effects that fire once the call ends. Configure email, webhook, or both.","properties":{"email":{"type":"object","properties":{"enabled":{"type":"boolean"},"recipients":{"type":"array","description":"Email addresses that should receive the notification.","items":{"type":"string","format":"email"}},"include":{"type":"array","description":"Which sections to include in the email body.","items":{"type":"string","enum":["summary","extracted_variables","fullConversation","sentiment"]}},"extracted_variables":{"type":"array","description":"Variables the model should pull out of the conversation for the email.","items":{"type":"object","required":["key","prompt"],"properties":{"key":{"type":"string","description":"Unique identifier for the variable in the post-call payload."},"prompt":{"type":"string","description":"Instruction for the model on what to pull out of the conversation."}}}},"trigger_call_statuses":{"type":"array","description":"Call outcomes that should fire this action. Omit to\nuse the default (`completed`, `voicemail_detected`).\nPass an explicit list to also include failed calls,\nno-answers, busy signals, etc.\n","items":{"type":"string","enum":["completed","voicemail_detected","failed","no_answer","busy","cancelled"]}}}},"webhook":{"type":"object","properties":{"enabled":{"type":"boolean"},"url":{"type":"string","format":"uri","description":"Endpoint that receives a POST with the call payload."},"include":{"type":"array","description":"Which sections to include in the webhook body.","items":{"type":"string","enum":["summary","extracted_variables","fullConversation","sentiment"]}},"extracted_variables":{"type":"array","description":"Variables the model should pull out of the conversation for the webhook.","items":{"type":"object","required":["key","prompt"],"properties":{"key":{"type":"string","description":"Unique identifier for the variable in the post-call payload."},"prompt":{"type":"string","description":"Instruction for the model on what to pull out of the conversation."}}}},"trigger_call_statuses":{"type":"array","description":"Call outcomes that should fire this webhook. Omit to\nuse the default (`completed`, `voicemail_detected`).\n","items":{"type":"string","enum":["completed","voicemail_detected","failed","no_answer","busy","cancelled"]}}}}}},"transfer":{"type":"object","description":"Conditional call transfer to a human agent or another number.","properties":{"enabled":{"type":"boolean"},"transfer_options":{"type":"array","description":"Where to transfer the call and under what condition. The first matching condition wins.","items":{"type":"object","required":["number","transfer_condition","transfer_message"],"properties":{"number":{"type":"string","description":"Primary phone number to transfer to. Include country code with leading `+`."},"type":{"type":"string","enum":["static","dynamic"],"default":"static","description":"`static` transfers to `number`. `dynamic` lets the agent\npick a number at runtime based on the conversation.\n"},"backup_numbers":{"type":"array","description":"Fallback numbers tried if the primary is unreachable.","items":{"type":"string"}},"transfer_condition":{"type":"string","description":"Natural-language condition that triggers this transfer option."},"transfer_message":{"type":"string","description":"Message the agent says to the caller before executing the transfer."}}}}}},"end_call":{"type":"object","description":"Hang up automatically when a condition is met.","properties":{"enabled":{"type":"boolean"},"condition":{"type":"string","description":"Natural-language condition that triggers ending the call. Only evaluated when `enabled` is true."},"message":{"type":"string","description":"What the agent says before hanging up."},"message_type":{"type":"string","enum":["static","prompt"],"description":"`static` speaks `message` verbatim. `prompt` treats\n`message_prompt` as an LLM instruction and generates a\nfresh closing line each call (useful for matching the\ncaller's language and tone).\n"},"message_prompt":{"type":"string","description":"LLM prompt used to generate the closing line when `message_type` is `prompt`."}}},"background_track":{"type":"object","description":"Ambient background noise that plays under the agent's voice.","properties":{"enabled":{"type":"boolean","description":"Whether to mix the ambient track under the agent's audio."},"name":{"type":"string","enum":["call_center","filler","office","office_1","restaurant"],"description":"Ambient track to mix under the agent."},"volume":{"type":"number","minimum":0,"maximum":1,"default":0.2,"description":"Volume level on a 0–1 scale. Default 0.2."},"tts_volume_reduction":{"type":"number","minimum":0,"maximum":1,"description":"Amount to drop the agent's TTS volume while the ambient track plays, on a 0–1 scale. Helps the voice cut through without raising the overall mix."}}},"initial_ringing_sound_enabled":{"type":"boolean","description":"Plays a ringing tone after the call is picked up, until the agent starts speaking."},"voicemail":{"type":"object","description":"Voicemail / answering-machine handling for outbound calls.","properties":{"enabled":{"type":"boolean","description":"Detect voicemail and react instead of speaking to a machine."},"message":{"type":"string","description":"Message to leave when voicemail is detected."}}},"languages":{"type":"array","description":"Languages the agent should support. Pass each language as a display-name string.","items":{"type":"string","enum":["English","English (India)","English (US)","Hindi","Bengali","Spanish","Tamil","Marathi","Telugu","Gujarati","French"]}}}}},"required":["agent_id","requestBody"]},
    method: "put",
    pathTemplate: "/agents/{agent_id}",
    executionParameters: [{"name":"agent_id","in":"path"}],
    requestBodyContentType: "application/json",
    securityRequirements: [{"BearerAuth":[]}]
  }],
  ["deleteAgent", {
    name: "deleteAgent",
    description: `Permanently delete an agent.`,
    inputSchema: {"type":"object","properties":{"agent_id":{"type":"number","description":"The ID of the agent."}},"required":["agent_id"]},
    method: "delete",
    pathTemplate: "/agents/{agent_id}",
    executionParameters: [{"name":"agent_id","in":"path"}],
    requestBodyContentType: undefined,
    securityRequirements: [{"BearerAuth":[]}]
  }],
  ["dispatchCall", {
    name: "dispatchCall",
    description: `Initiate a call to a phone number using a specified agent. The
phone number must include a country code with a leading plus.
`,
    inputSchema: {"type":"object","properties":{"requestBody":{"type":"object","required":["agent_id","to_number"],"properties":{"agent_id":{"type":"number","description":"The ID of the agent that will handle the call."},"to_number":{"type":"string","description":"The phone number to call. Must include country code (e.g., +15551234567)."},"from_number_id":{"type":"number","description":"The imported phone number id to call."},"call_context":{"type":"object","description":"Optional context information as key-value pairs to be passed to the agent during the call. Can contain any custom fields relevant to your use case.","additionalProperties":true}},"description":"The JSON request body."}},"required":["requestBody"]},
    method: "post",
    pathTemplate: "/calls/dispatch",
    executionParameters: [],
    requestBodyContentType: "application/json",
    securityRequirements: [{"BearerAuth":[]}]
  }],
  ["listCallLogs", {
    name: "listCallLogs",
    description: `Retrieve call logs with pagination and optional filtering.`,
    inputSchema: {"type":"object","properties":{"pageno":{"type":"integer","minimum":1,"default":1,"description":"Page number for pagination."},"pagesize":{"type":"integer","minimum":1,"default":30,"maximum":150,"description":"Number of items per page."},"agentid":{"type":"number","description":"Filter by agent ID."},"call_status":{"type":"string","enum":["completed","busy","failed","no-answer"]},"bulk_call_id":{"type":"number","description":"Filter by bulk-call campaign ID."}}},
    method: "get",
    pathTemplate: "/calls/logs",
    executionParameters: [{"name":"pageno","in":"query"},{"name":"pagesize","in":"query"},{"name":"agentid","in":"query"},{"name":"call_status","in":"query"},{"name":"bulk_call_id","in":"query"}],
    requestBodyContentType: undefined,
    securityRequirements: [{"BearerAuth":[]}]
  }],
  ["getCallLog", {
    name: "getCallLog",
    description: `Detailed information about a specific call (duration, status, transcript, sentiment, extracted variables).`,
    inputSchema: {"type":"object","properties":{"call_log_id":{"type":"number"}},"required":["call_log_id"]},
    method: "get",
    pathTemplate: "/calls/logs/{call_log_id}",
    executionParameters: [{"name":"call_log_id","in":"path"}],
    requestBodyContentType: undefined,
    securityRequirements: [{"BearerAuth":[]}]
  }],
  ["fetchBulkCalls", {
    name: "fetchBulkCalls",
    description: `List bulk-call campaigns with pagination and optional status filter.`,
    inputSchema: {"type":"object","properties":{"pageno":{"type":"integer","minimum":1,"default":1},"pagesize":{"type":"integer","minimum":1,"default":10,"maximum":150,"description":"Items per page (max 150 — sending more returns 500)."},"status":{"type":"string","description":"Filter by status (e.g. completed)."}}},
    method: "get",
    pathTemplate: "/calls/bulk_call",
    executionParameters: [{"name":"pageno","in":"query"},{"name":"pagesize","in":"query"},{"name":"status","in":"query"}],
    requestBodyContentType: undefined,
    securityRequirements: [{"BearerAuth":[]}]
  }],
  ["createBulkCall", {
    name: "createBulkCall",
    description: `Create a new bulk-call campaign. Supports immediate, scheduled, and auto-retry modes.`,
    inputSchema: {"type":"object","properties":{"requestBody":{"type":"object","required":["name","contact_list","phone_number_id"],"properties":{"name":{"type":"string","description":"Name of the bulk call campaign."},"phone_number_id":{"type":"string","description":"Your phone number id to use for making calls."},"contact_list":{"type":"array","minItems":1,"description":"Array of contact objects. Each row needs `phone_number`.\nAny other key you add on the row (e.g. `customer_name`,\n`account_id`, `priority`) is passed to the agent as a\ncontext variable for that specific call, so the agent\ncan reference it during the conversation.\n","items":{"type":"object","required":["phone_number"],"properties":{"phone_number":{"type":"string","description":"Phone number in international format (e.g., +15551234567)."}},"additionalProperties":true}},"is_scheduled":{"type":"boolean","default":false,"description":"Whether the campaign should be scheduled for future execution."},"scheduled_datetime":{"type":"string","description":"Scheduled execution time in format `YYYY-MM-DD HH:MM:SS` (required if `is_scheduled` is true)."},"timezone":{"type":"string","default":"UTC","description":"Timezone for scheduled execution."},"concurrent_call_limit":{"type":"number","default":1,"minimum":1,"description":"Maximum number of concurrent calls allowed."},"enabled_reschedule_call":{"type":"boolean","default":false,"description":"Enable automatic call rescheduling. When enabled the system can reschedule unreachable calls."},"retry_config":{"type":"object","description":"Auto-retry configuration object containing retry settings.","properties":{"auto_retry":{"type":"boolean","default":false},"auto_retry_schedule":{"type":"string","enum":["immediately","next_day","scheduled_time"],"description":"When to retry failed calls."},"retry_schedule_days":{"type":"number","default":0,"minimum":0,"description":"Days to wait before a scheduled retry."},"retry_schedule_hours":{"type":"number","default":0,"minimum":0,"description":"Hours to wait before a scheduled retry."},"retry_limit":{"type":"number","default":0,"minimum":0,"maximum":5,"description":"Maximum number of retry attempts (0–5)."}}}},"description":"The JSON request body."}},"required":["requestBody"]},
    method: "post",
    pathTemplate: "/calls/bulk_call/create",
    executionParameters: [],
    requestBodyContentType: "application/json",
    securityRequirements: [{"BearerAuth":[]}]
  }],
  ["getBulkCall", {
    name: "getBulkCall",
    description: `Get detailed information about a bulk-call campaign.`,
    inputSchema: {"type":"object","properties":{"bulk_call_id":{"type":"number"}},"required":["bulk_call_id"]},
    method: "get",
    pathTemplate: "/calls/bulk_call/{bulk_call_id}",
    executionParameters: [{"name":"bulk_call_id","in":"path"}],
    requestBodyContentType: undefined,
    securityRequirements: [{"BearerAuth":[]}]
  }],
  ["bulkCallActions", {
    name: "bulkCallActions",
    description: `Pause, resume, or reschedule a running campaign.`,
    inputSchema: {"type":"object","properties":{"bulk_call_id":{"type":"number"},"requestBody":{"type":"object","required":["action"],"properties":{"action":{"type":"string","enum":["pause","resume","reschedule"],"description":"What to do with the campaign."},"new_scheduled_datetime":{"type":"string","description":"New start time for `reschedule`. Format `YYYY-MM-DD HH:MM:SS`."},"new_timezone":{"type":"string","description":"IANA timezone for `reschedule`."}},"description":"The JSON request body."}},"required":["bulk_call_id","requestBody"]},
    method: "put",
    pathTemplate: "/calls/bulk_call/{bulk_call_id}",
    executionParameters: [{"name":"bulk_call_id","in":"path"}],
    requestBodyContentType: "application/json",
    securityRequirements: [{"BearerAuth":[]}]
  }],
  ["cancelBulkCall", {
    name: "cancelBulkCall",
    description: `Cancel a bulk-call campaign.`,
    inputSchema: {"type":"object","properties":{"bulk_call_id":{"type":"number"}},"required":["bulk_call_id"]},
    method: "delete",
    pathTemplate: "/calls/bulk_call/{bulk_call_id}",
    executionParameters: [{"name":"bulk_call_id","in":"path"}],
    requestBodyContentType: undefined,
    securityRequirements: [{"BearerAuth":[]}]
  }],
  ["getBulkCallLiveStatus", {
    name: "getBulkCallLiveStatus",
    description: `Real-time status of a running bulk-call campaign.`,
    inputSchema: {"type":"object","properties":{"bulk_call_id":{"type":"number"}},"required":["bulk_call_id"]},
    method: "get",
    pathTemplate: "/bulk-call/{bulk_call_id}/live-status",
    executionParameters: [{"name":"bulk_call_id","in":"path"}],
    requestBodyContentType: undefined,
    securityRequirements: [{"BearerAuth":[]}]
  }],
  ["listKnowledgeBaseFiles", {
    name: "listKnowledgeBaseFiles",
    description: `List all knowledge-base files for the authenticated user.`,
    inputSchema: {"type":"object","properties":{}},
    method: "get",
    pathTemplate: "/knowledge_base/list",
    executionParameters: [],
    requestBodyContentType: undefined,
    securityRequirements: [{"BearerAuth":[]}]
  }],
  ["canUploadFile", {
    name: "canUploadFile",
    description: `Check whether a file can be uploaded based on size and type.`,
    inputSchema: {"type":"object","properties":{"requestBody":{"type":"object","required":["file_size","file_type"],"properties":{"file_size":{"type":"number","minimum":1,"description":"Size in bytes."},"file_type":{"type":"string","description":"File extension. Only `pdf` is accepted."}},"description":"The JSON request body."}},"required":["requestBody"]},
    method: "post",
    pathTemplate: "/knowledge_base/can_upload",
    executionParameters: [],
    requestBodyContentType: "application/json",
    securityRequirements: [{"BearerAuth":[]}]
  }],
  ["uploadKnowledgeBaseFile", {
    name: "uploadKnowledgeBaseFile",
    description: `Upload a PDF file. The file content must be Base64 encoded.`,
    inputSchema: {"type":"object","properties":{"requestBody":{"type":"object","required":["file","filename"],"properties":{"file":{"type":"string","description":"Base64-encoded file content."},"filename":{"type":"string","description":"Filename including the `.pdf` extension."}},"description":"The JSON request body."}},"required":["requestBody"]},
    method: "post",
    pathTemplate: "/knowledge_base/create",
    executionParameters: [],
    requestBodyContentType: "application/json",
    securityRequirements: [{"BearerAuth":[]}]
  }],
  ["attachKnowledgeBaseFiles", {
    name: "attachKnowledgeBaseFiles",
    description: `Attach multiple knowledge-base files to an agent.`,
    inputSchema: {"type":"object","properties":{"requestBody":{"type":"object","required":["file_ids","agent_id"],"properties":{"file_ids":{"type":"array","minItems":1,"items":{"type":"number"},"description":"List of knowledge-base file IDs to attach."},"agent_id":{"type":"number","description":"ID of the agent to attach files to."},"when_to_use":{"type":"string","description":"Instruction to the agent on when to consult these files."}},"description":"The JSON request body."}},"required":["requestBody"]},
    method: "post",
    pathTemplate: "/knowledge_base/attach",
    executionParameters: [],
    requestBodyContentType: "application/json",
    securityRequirements: [{"BearerAuth":[]}]
  }],
  ["detachKnowledgeBaseFiles", {
    name: "detachKnowledgeBaseFiles",
    description: `Detach multiple knowledge-base files from an agent.`,
    inputSchema: {"type":"object","properties":{"requestBody":{"type":"object","required":["file_ids","agent_id"],"properties":{"file_ids":{"type":"array","minItems":1,"items":{"type":"number"},"description":"List of knowledge-base file IDs to detach."},"agent_id":{"type":"number","description":"ID of the agent to detach files from."}},"description":"The JSON request body."}},"required":["requestBody"]},
    method: "post",
    pathTemplate: "/knowledge_base/detach",
    executionParameters: [],
    requestBodyContentType: "application/json",
    securityRequirements: [{"BearerAuth":[]}]
  }],
  ["deleteKnowledgeBaseFile", {
    name: "deleteKnowledgeBaseFile",
    description: `Permanently delete a file. Removes it from any attached agents. Cannot be undone.`,
    inputSchema: {"type":"object","properties":{"requestBody":{"type":"object","required":["file_id"],"properties":{"file_id":{"type":"number","description":"ID of the file to delete."}},"description":"The JSON request body."}},"required":["requestBody"]},
    method: "post",
    pathTemplate: "/knowledge_base/delete",
    executionParameters: [],
    requestBodyContentType: "application/json",
    securityRequirements: [{"BearerAuth":[]}]
  }],
  ["listPhoneNumbers", {
    name: "listPhoneNumbers",
    description: `Retrieve all phone numbers associated with your account.`,
    inputSchema: {"type":"object","properties":{"pageno":{"type":"integer","minimum":1,"default":1},"pagesize":{"type":"integer","minimum":1,"default":30,"maximum":150}}},
    method: "get",
    pathTemplate: "/phone_number/list",
    executionParameters: [{"name":"pageno","in":"query"},{"name":"pagesize","in":"query"}],
    requestBodyContentType: undefined,
    securityRequirements: [{"BearerAuth":[]}]
  }],
  ["attachPhoneNumber", {
    name: "attachPhoneNumber",
    description: `Attach an account-owned phone number to an existing agent.`,
    inputSchema: {"type":"object","properties":{"requestBody":{"type":"object","required":["phone_number_id","agent_id"],"properties":{"phone_number_id":{"type":"number","description":"ID of the phone number to attach."},"agent_id":{"type":"number","description":"ID of the agent to attach the phone number to."}},"description":"The JSON request body."}},"required":["requestBody"]},
    method: "post",
    pathTemplate: "/phone_number/attach",
    executionParameters: [],
    requestBodyContentType: "application/json",
    securityRequirements: [{"BearerAuth":[]}]
  }],
  ["detachPhoneNumber", {
    name: "detachPhoneNumber",
    description: `Detach a phone number from its associated agent.`,
    inputSchema: {"type":"object","properties":{"requestBody":{"type":"object","required":["phone_number_id"],"properties":{"phone_number_id":{"type":"number","description":"ID of the phone number to detach."}},"description":"The JSON request body."}},"required":["requestBody"]},
    method: "post",
    pathTemplate: "/phone_number/detach",
    executionParameters: [],
    requestBodyContentType: "application/json",
    securityRequirements: [{"BearerAuth":[]}]
  }],
  ["importTwilioNumber", {
    name: "importTwilioNumber",
    description: `Import an existing Twilio number by providing your Twilio credentials.`,
    inputSchema: {"type":"object","properties":{"requestBody":{"type":"object","required":["phone_number","account_sid","account_token"],"properties":{"phone_number":{"type":"string","description":"Phone number in E.164 format (starting with `+`)."},"account_sid":{"type":"string","description":"Your Twilio account SID."},"account_token":{"type":"string","description":"Your Twilio auth token."},"name":{"type":"string","description":"Optional friendly name for the imported number."}},"description":"The JSON request body."}},"required":["requestBody"]},
    method: "post",
    pathTemplate: "/phone_number/import/twilio",
    executionParameters: [],
    requestBodyContentType: "application/json",
    securityRequirements: [{"BearerAuth":[]}]
  }],
  ["importExotelNumber", {
    name: "importExotelNumber",
    description: `Import an Exotel number by providing your Exotel credentials.`,
    inputSchema: {"type":"object","properties":{"requestBody":{"type":"object","required":["exotel_phone_number","exotel_api_key","exotel_api_token","exotel_subdomain","exotel_account_sid","exotel_app_id"],"properties":{"exotel_phone_number":{"type":"string","description":"Exotel phone number in E.164 format."},"exotel_api_key":{"type":"string","description":"Your Exotel API key."},"exotel_api_token":{"type":"string","description":"Your Exotel API token."},"exotel_subdomain":{"type":"string","description":"Your Exotel subdomain (e.g. `your-account.in.exotel.com`)."},"exotel_account_sid":{"type":"string","description":"Your Exotel account SID."},"exotel_app_id":{"type":"string","description":"The Exotel App ID configured for the bot."},"name":{"type":"string","description":"Optional friendly name for the imported number."}},"description":"The JSON request body."}},"required":["requestBody"]},
    method: "post",
    pathTemplate: "/phone_number/import/exotel",
    executionParameters: [],
    requestBodyContentType: "application/json",
    securityRequirements: [{"BearerAuth":[]}]
  }],
  ["importSipTrunk", {
    name: "importSipTrunk",
    description: `Import a phone number associated with a SIP trunk.`,
    inputSchema: {"type":"object","properties":{"requestBody":{"type":"object","required":["phone_number","sip_host","sip_trunk_name"],"properties":{"phone_number":{"type":"string","description":"Phone number in E.164 format (starting with `+`)."},"sip_host":{"type":"string","description":"SIP server hostname or IP."},"sip_trunk_name":{"type":"string","description":"Name for this SIP trunk (must be unique within your account)."},"name":{"type":"string","description":"Optional friendly name for the imported number."},"sip_port":{"type":"number","default":5060,"description":"SIP server port."},"sip_username":{"type":"string","description":"SIP authentication username."},"sip_password":{"type":"string","format":"password","description":"SIP authentication password."},"sip_dial_prefix":{"type":"string","description":"Optional prefix to prepend before the destination number when dialing (e.g. to strip the country code)."},"sip_strip_plus":{"type":"boolean","description":"When true, strips the leading `+` from the dialed number."}},"description":"The JSON request body."}},"required":["requestBody"]},
    method: "post",
    pathTemplate: "/phone_number/import/sip",
    executionParameters: [],
    requestBodyContentType: "application/json",
    securityRequirements: [{"BearerAuth":[]}]
  }],
  ["listLLMProviders", {
    name: "listLLMProviders",
    description: `Retrieve all available Large Language Model providers.`,
    inputSchema: {"type":"object","properties":{}},
    method: "get",
    pathTemplate: "/providers/llms",
    executionParameters: [],
    requestBodyContentType: undefined,
    securityRequirements: [{"BearerAuth":[]}]
  }],
  ["listVoices", {
    name: "listVoices",
    description: `Retrieve voices with filtering and pagination support. ElevenLabs
supports advanced filtering by name, language, accent, and gender.
Other providers support basic pagination only.
`,
    inputSchema: {"type":"object","properties":{"provider":{"type":"string","enum":["eleven_labs","google","deepgram","cartesia","sarvam"],"description":"TTS provider to list voices from. Omit to list across all providers."},"search":{"type":"string","description":"Substring match against voice name or description. ElevenLabs only."},"language":{"type":"string","description":"ISO language code (e.g. `en`, `hi`, `es`). ElevenLabs only."},"accent":{"type":"string","description":"Accent label (e.g. `american`, `british`). ElevenLabs only."},"gender":{"type":"string","enum":["male","female"],"description":"Filter voices by gender. ElevenLabs only."},"page":{"type":"integer","minimum":1,"default":1,"description":"1-indexed page number."},"page_size":{"type":"integer","minimum":1,"default":30,"maximum":100,"description":"Voices per page. Capped at 100."}}},
    method: "get",
    pathTemplate: "/providers/voices",
    executionParameters: [{"name":"provider","in":"query"},{"name":"search","in":"query"},{"name":"language","in":"query"},{"name":"accent","in":"query"},{"name":"gender","in":"query"},{"name":"page","in":"query"},{"name":"page_size","in":"query"}],
    requestBodyContentType: undefined,
    securityRequirements: [{"BearerAuth":[]}]
  }],
  ["listSTTProviders", {
    name: "listSTTProviders",
    description: `Retrieve all Speech-to-Text providers.`,
    inputSchema: {"type":"object","properties":{}},
    method: "get",
    pathTemplate: "/providers/stt",
    executionParameters: [],
    requestBodyContentType: undefined,
    securityRequirements: [{"BearerAuth":[]}]
  }],
  ["listTTSProviders", {
    name: "listTTSProviders",
    description: `Retrieve all Text-to-Speech providers.`,
    inputSchema: {"type":"object","properties":{}},
    method: "get",
    pathTemplate: "/providers/tts",
    executionParameters: [],
    requestBodyContentType: undefined,
    securityRequirements: [{"BearerAuth":[]}]
  }],
  ["listAllProviders", {
    name: "listAllProviders",
    description: `Comprehensive response with services and voices in one payload.`,
    inputSchema: {"type":"object","properties":{}},
    method: "get",
    pathTemplate: "/providers/all",
    executionParameters: [],
    requestBodyContentType: undefined,
    securityRequirements: [{"BearerAuth":[]}]
  }],
  ["getVoice", {
    name: "getVoice",
    description: `Detailed metadata for a specific voice.`,
    inputSchema: {"type":"object","properties":{"voice_id":{"type":"number"}},"required":["voice_id"]},
    method: "get",
    pathTemplate: "/providers/voice/{voice_id}",
    executionParameters: [{"name":"voice_id","in":"path"}],
    requestBodyContentType: undefined,
    securityRequirements: [{"BearerAuth":[]}]
  }],
  ["listSimulations", {
    name: "listSimulations",
    description: `Retrieve simulations with pagination.`,
    inputSchema: {"type":"object","properties":{"pageno":{"type":"integer","minimum":1,"default":1},"pagesize":{"type":"integer","minimum":1,"default":10,"maximum":150}}},
    method: "get",
    pathTemplate: "/simulations",
    executionParameters: [{"name":"pageno","in":"query"},{"name":"pagesize","in":"query"}],
    requestBodyContentType: undefined,
    securityRequirements: [{"BearerAuth":[]}]
  }],
  ["createSimulation", {
    name: "createSimulation",
    description: `Create a new test simulation with scenarios.`,
    inputSchema: {"type":"object","properties":{"requestBody":{"type":"object","required":["name","agent_id"],"properties":{"name":{"type":"string","description":"Name of the simulation."},"agent_id":{"type":"number","description":"ID of the agent to test."},"number_of_call_to_make":{"type":"number","default":1,"minimum":1,"maximum":3,"description":"Number of calls to make per scenario (default 1, max 3)."},"concurrent_call_count":{"type":"number","default":3,"minimum":1,"maximum":3,"description":"Number of concurrent calls to run (default 3, max 3)."},"max_call_duration_in_minutes":{"type":"number","default":3,"minimum":1,"maximum":10,"description":"Maximum duration for each call in minutes (default 3, max 10)."},"scenarios":{"type":"array","description":"List of test scenarios to execute.","items":{"type":"object","required":["name","description","expected_result"],"properties":{"name":{"type":"string","description":"Name of the test scenario."},"description":{"type":"string","description":"Detailed instructions for the test scenario."},"expected_result":{"type":"string","description":"Expected outcome or behavior from the agent."},"selected_voices":{"type":"array","description":"Voice configurations for the test calls. If multiple voices are selected, the agent randomly picks one per call per scenario.","items":{"type":"object","required":["id","provider"],"properties":{"id":{"type":"string","description":"Voice ID from the provider."},"provider":{"type":"string","enum":["eleven_labs","play_ht","deepgram","cartesia","rime"]}}}}}}}},"description":"The JSON request body."}},"required":["requestBody"]},
    method: "post",
    pathTemplate: "/simulations",
    executionParameters: [],
    requestBodyContentType: "application/json",
    securityRequirements: [{"BearerAuth":[]}]
  }],
  ["getSimulation", {
    name: "getSimulation",
    description: `Detailed simulation information.`,
    inputSchema: {"type":"object","properties":{"simulation_id":{"type":"number"}},"required":["simulation_id"]},
    method: "get",
    pathTemplate: "/simulations/{simulation_id}",
    executionParameters: [{"name":"simulation_id","in":"path"}],
    requestBodyContentType: undefined,
    securityRequirements: [{"BearerAuth":[]}]
  }],
  ["updateSimulation", {
    name: "updateSimulation",
    description: `Update an existing simulation. Pass the full \`scenarios\` array (existing entries you want to keep plus any changes).`,
    inputSchema: {"type":"object","properties":{"simulation_id":{"type":"number"},"requestBody":{"type":"object","properties":{"name":{"type":"string","description":"Name of the simulation for identification."},"agent_id":{"type":"number","description":"ID of the agent to test."},"number_of_call_to_make":{"type":"number","minimum":1,"maximum":3,"description":"Number of calls to make per scenario (default 1, max 3)."},"concurrent_call_count":{"type":"number","minimum":1,"maximum":3,"description":"Number of concurrent calls to run (default 3, max 3)."},"max_call_duration_in_minutes":{"type":"number","minimum":1,"maximum":10,"description":"Maximum duration for each call in minutes (default 3, max 10)."},"scenarios":{"type":"array","description":"Full scenario list. Include existing scenarios you want to keep, plus any new or updated ones.","items":{"type":"object","required":["name","description","expected_result"],"properties":{"id":{"type":"number","description":"Include this to update an existing scenario; omit it to add a new one."},"name":{"type":"string","description":"Name of the test scenario."},"description":{"type":"string","description":"Updated instructions for the test scenario."},"expected_result":{"type":"string","description":"Updated expected outcome from the agent."},"selected_voices":{"type":"array","description":"Updated voice configurations for the test calls.","items":{"type":"object","required":["id","provider"],"properties":{"id":{"type":"string","description":"Voice ID from the provider."},"provider":{"type":"string","enum":["eleven_labs","play_ht","deepgram","cartesia","rime"]}}}}}}}},"description":"The JSON request body."}},"required":["simulation_id","requestBody"]},
    method: "put",
    pathTemplate: "/simulations/{simulation_id}",
    executionParameters: [{"name":"simulation_id","in":"path"}],
    requestBodyContentType: "application/json",
    securityRequirements: [{"BearerAuth":[]}]
  }],
  ["deleteSimulation", {
    name: "deleteSimulation",
    description: `Permanently delete a simulation.`,
    inputSchema: {"type":"object","properties":{"simulation_id":{"type":"number"}},"required":["simulation_id"]},
    method: "delete",
    pathTemplate: "/simulations/{simulation_id}",
    executionParameters: [{"name":"simulation_id","in":"path"}],
    requestBodyContentType: undefined,
    securityRequirements: [{"BearerAuth":[]}]
  }],
  ["startSimulation", {
    name: "startSimulation",
    description: `Begin running a simulation. Optionally update scenarios at start time (same shape as Update simulation).`,
    inputSchema: {"type":"object","properties":{"simulation_id":{"type":"number"},"requestBody":{"type":"object","properties":{"scenarios":{"type":"array","description":"Optional array of scenarios to update before starting.","items":{"type":"object","required":["name","description","expected_result"],"properties":{"id":{"type":"number","description":"Include this to update an existing scenario; omit it to add a new one."},"name":{"type":"string"},"description":{"type":"string","description":"Updated instructions for the test scenario."},"expected_result":{"type":"string","description":"Updated expected outcome from the agent."},"selected_voices":{"type":"array","description":"Updated voice configurations for the test calls.","items":{"type":"object","required":["id","provider"],"properties":{"id":{"type":"string","description":"Voice ID from the provider."},"provider":{"type":"string","enum":["eleven_labs","play_ht","deepgram","cartesia","rime"]}}}}}}}},"description":"The JSON request body."}},"required":["simulation_id"]},
    method: "post",
    pathTemplate: "/simulations/{simulation_id}/start",
    executionParameters: [{"name":"simulation_id","in":"path"}],
    requestBodyContentType: "application/json",
    securityRequirements: [{"BearerAuth":[]}]
  }],
  ["stopSimulation", {
    name: "stopSimulation",
    description: `Stop a running simulation.`,
    inputSchema: {"type":"object","properties":{"simulation_id":{"type":"number"}},"required":["simulation_id"]},
    method: "post",
    pathTemplate: "/simulations/{simulation_id}/stop",
    executionParameters: [{"name":"simulation_id","in":"path"}],
    requestBodyContentType: undefined,
    securityRequirements: [{"BearerAuth":[]}]
  }],
  ["enhancePrompt", {
    name: "enhancePrompt",
    description: `Generate prompt-improvement suggestions for a completed simulation.`,
    inputSchema: {"type":"object","properties":{"simulation_id":{"type":"number"}},"required":["simulation_id"]},
    method: "post",
    pathTemplate: "/simulations/{simulation_id}/enhance-prompt",
    executionParameters: [{"name":"simulation_id","in":"path"}],
    requestBodyContentType: undefined,
    securityRequirements: [{"BearerAuth":[]}]
  }],
  ["listChildOrganizations", {
    name: "listChildOrganizations",
    description: `List all child organizations and their users under the reseller
account. Returns each organization's balance, cost-per-minute
rate, and concurrency limit, plus the dashboard menu access
flags scoped to your reseller's permissions for every user.
`,
    inputSchema: {"type":"object","properties":{}},
    method: "get",
    pathTemplate: "/reseller/organizations",
    executionParameters: [],
    requestBodyContentType: undefined,
    securityRequirements: [{"BearerAuth":[]}]
  }],
  ["addUser", {
    name: "addUser",
    description: `Create a new child user and organization under the reseller.
The new organization is linked to your reseller account
automatically.
`,
    inputSchema: {"type":"object","properties":{"requestBody":{"type":"object","required":["name","email","phone","password"],"properties":{"name":{"type":"string","description":"Full name of the new user."},"email":{"type":"string","format":"email","description":"Email address. Also used as the login."},"phone":{"type":"string","description":"Phone number including country code (e.g. `+15551234567`)."},"password":{"type":"string","format":"password","description":"Account password for the new user."},"welcome_minutes_to_credit":{"type":"number","description":"Minutes to credit to the new account on signup."},"cost_per_min":{"type":"number","description":"Cost per minute charged to this user (e.g. `0.20`). Must be at least the reseller's premium model rate."},"concurrent_call_limit":{"type":"number","description":"Maximum number of concurrent calls allowed for this account."},"expiry_date":{"type":"string","format":"date","description":"Account expiry date in `YYYY-MM-DD` format (e.g. `2026-12-31`)."},"user_currency":{"type":"string","description":"ISO 4217 currency code for the account (e.g. `USD`, `INR`). Defaults to the reseller's currency."}},"description":"The JSON request body."}},"required":["requestBody"]},
    method: "post",
    pathTemplate: "/reseller/users/add",
    executionParameters: [],
    requestBodyContentType: "application/json",
    securityRequirements: [{"BearerAuth":[]}]
  }],
  ["setUserAccessControl", {
    name: "setUserAccessControl",
    description: `Enable or disable dashboard menu access flags for a child user.
Only the flags you pass are changed. Flags outside your
reseller's permissions are silently ignored.
`,
    inputSchema: {"type":"object","properties":{"requestBody":{"type":"object","required":["user_id","dashboard_menu_access"],"properties":{"user_id":{"type":"number","description":"ID of the child user to update."},"dashboard_menu_access":{"allOf":[{"type":"object","description":"Reseller-managed dashboard menu access flags. Each property is\na boolean toggle for a feature area in the child user's\ndashboard. On read endpoints, only flags the reseller\nthemselves has enabled are returned (so a child cannot have a\nflag the reseller doesn't have).\n","properties":{"is_bots_menu_access":{"type":"boolean"},"is_leads_access":{"type":"boolean"},"is_voice_cloning_access":{"type":"boolean"},"is_workflow_access":{"type":"boolean"},"is_asr_evaluation_menu_access":{"type":"boolean"},"is_train_with_call_recording_menu_access":{"type":"boolean"},"is_call_logs_menu_access":{"type":"boolean"},"is_call_simulation_menu_access":{"type":"boolean"},"is_omni_crm_access":{"type":"boolean"},"access_to_monitor_live_call":{"type":"boolean"},"is_whatsapp_flow_enabled":{"type":"boolean"},"is_billing_menu_access":{"type":"boolean"},"is_knowledge_base_access":{"type":"boolean"},"is_integration_access":{"type":"boolean"},"is_phone_number_access":{"type":"boolean"},"is_bulk_call_access":{"type":"boolean"},"is_analytics_access":{"type":"boolean"}}}],"description":"Flags to update. Only pass the flags you want to\nchange. Others are left untouched. Flags outside\nyour reseller's permissions are silently dropped.\n"}},"description":"The JSON request body."}},"required":["requestBody"]},
    method: "post",
    pathTemplate: "/reseller/users/access-control",
    executionParameters: [],
    requestBodyContentType: "application/json",
    securityRequirements: [{"BearerAuth":[]}]
  }],
  ["setUserExpiry", {
    name: "setUserExpiry",
    description: `Set or remove the expiry date on a child user. The user must
belong to a child organization of your reseller.
`,
    inputSchema: {"type":"object","properties":{"requestBody":{"type":"object","required":["user_id"],"properties":{"user_id":{"type":"number","description":"ID of the child user to update."},"expiry_date":{"type":["string","null"],"format":"date","description":"Expiry date in `YYYY-MM-DD` format. Omit or pass `null` to remove the expiry."}},"description":"The JSON request body."}},"required":["requestBody"]},
    method: "post",
    pathTemplate: "/reseller/users/expiry",
    executionParameters: [],
    requestBodyContentType: "application/json",
    securityRequirements: [{"BearerAuth":[]}]
  }],
  ["setChildConcurrency", {
    name: "setChildConcurrency",
    description: `Set the maximum number of simultaneous calls a child
organization can run. Slots come from the reseller's shared
pool. Increasing the limit deducts the delta from your pool
and fails if you don't have enough slots. Decreasing the
limit returns the delta to your pool immediately.
`,
    inputSchema: {"type":"object","properties":{"requestBody":{"type":"object","required":["child_organization_id","new_limit"],"properties":{"child_organization_id":{"type":"number","description":"ID of the child organization to update."},"new_limit":{"type":"number","description":"The desired absolute concurrent call limit (must be `>= 0`)."}},"description":"The JSON request body."}},"required":["requestBody"]},
    method: "post",
    pathTemplate: "/reseller/concurrency",
    executionParameters: [],
    requestBodyContentType: "application/json",
    securityRequirements: [{"BearerAuth":[]}]
  }],
  ["calculateCreditOperation", {
    name: "calculateCreditOperation",
    description: `Preview the cost of a transfer or revert without moving any
credits. Use this to confirm amounts before calling the
transfer or revert endpoints. The response shape differs
between forward transfers and reverts. See the examples.
`,
    inputSchema: {"type":"object","properties":{"requestBody":{"type":"object","required":["minutes"],"properties":{"minutes":{"type":"number","description":"Number of minutes to calculate for."},"cost_per_min":{"type":"number","description":"Rate per minute for a forward transfer (e.g. `0.20`). Not required when `is_revert` is `true`."},"is_revert":{"type":"boolean","description":"Set to `true` to calculate a revert instead of a forward transfer.","default":false},"child_organization_id":{"type":"number","description":"ID of the child organization to revert credits from. Required when `is_revert` is `true`."}},"description":"The JSON request body."}},"required":["requestBody"]},
    method: "post",
    pathTemplate: "/reseller/credits/calculate",
    executionParameters: [],
    requestBodyContentType: "application/json",
    securityRequirements: [{"BearerAuth":[]}]
  }],
  ["transferCreditsToChild", {
    name: "transferCreditsToChild",
    description: `Transfer minutes from the reseller balance to a child
organization. Credits are deducted from your balance
immediately on success. The target organization must be a
direct child of your reseller. Use the calculate endpoint
first to preview the cost.
`,
    inputSchema: {"type":"object","properties":{"requestBody":{"type":"object","required":["to_organization_id","minutes","cost_per_min"],"properties":{"to_organization_id":{"type":"number","description":"ID of the child organization to transfer credits to."},"minutes":{"type":"number","description":"Number of minutes to transfer."},"cost_per_min":{"type":"number","description":"Rate per minute to charge the child organization (e.g. `0.20`)."}},"description":"The JSON request body."}},"required":["requestBody"]},
    method: "post",
    pathTemplate: "/reseller/credits/transfer",
    executionParameters: [],
    requestBodyContentType: "application/json",
    securityRequirements: [{"BearerAuth":[]}]
  }],
  ["revertCreditsFromChild", {
    name: "revertCreditsFromChild",
    description: `Take back unused minutes from a child organization to the
reseller balance. The refund is calculated at the child's
current rate, so you don't pass one. This matches exactly
what was originally charged. Use the calculate endpoint
first to preview the refund.
`,
    inputSchema: {"type":"object","properties":{"requestBody":{"type":"object","required":["from_organization_id","minutes"],"properties":{"from_organization_id":{"type":"number","description":"ID of the child organization to revert credits from."},"minutes":{"type":"number","description":"Number of minutes to revert."}},"description":"The JSON request body."}},"required":["requestBody"]},
    method: "post",
    pathTemplate: "/reseller/credits/revert",
    executionParameters: [],
    requestBodyContentType: "application/json",
    securityRequirements: [{"BearerAuth":[]}]
  }],
  ["getResellerCreditLogs", {
    name: "getResellerCreditLogs",
    description: `Paginated history of all credit transfers and reverts for the
reseller account. Returns reverse-chronological order by
default. Date filters are inclusive.
`,
    inputSchema: {"type":"object","properties":{"page":{"type":"integer","minimum":1,"default":1,"description":"Page number for pagination."},"page_size":{"type":"number","default":20,"description":"Number of records per page (max 100)."},"date_from":{"type":"string","format":"date","description":"Filter logs from this date in `YYYY-MM-DD` format (e.g. `2026-01-01`)."},"date_to":{"type":"string","format":"date","description":"Filter logs up to and including this date in `YYYY-MM-DD` format (e.g. `2026-03-31`)."}}},
    method: "get",
    pathTemplate: "/reseller/credits/logs",
    executionParameters: [{"name":"page","in":"query"},{"name":"page_size","in":"query"},{"name":"date_from","in":"query"},{"name":"date_to","in":"query"}],
    requestBodyContentType: undefined,
    securityRequirements: [{"BearerAuth":[]}]
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
    inputSchema: def.inputSchema
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
        // Check if we have the necessary credentials
        const clientId = process.env[`OAUTH_CLIENT_ID_SCHEMENAME`];
        const clientSecret = process.env[`OAUTH_CLIENT_SECRET_SCHEMENAME`];
        const scopes = process.env[`OAUTH_SCOPES_SCHEMENAME`];
        
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
        if (error instanceof ZodError) {
            const validationErrorMessage = `Invalid arguments for tool '${toolName}': ${error.errors.map(e => `${e.path.join('.')} (${e.code}): ${e.message}`).join(', ')}`;
            return { content: [{ type: 'text', text: validationErrorMessage }] };
        } else {
             const errorMessage = error instanceof Error ? error.message : String(error);
             return { content: [{ type: 'text', text: `Internal error during validation setup: ${errorMessage}` }] };
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
                    return !!(process.env.OMNIDIM_API_KEY || process.env[`BEARER_TOKEN_${schemeName.replace(/[^a-zA-Z0-9]/g, '_').toUpperCase()}`]);
                }
                else if (scheme.scheme?.toLowerCase() === 'basic') {
                    return !!process.env[`BASIC_USERNAME_${schemeName.replace(/[^a-zA-Z0-9]/g, '_').toUpperCase()}`] && 
                           !!process.env[`BASIC_PASSWORD_${schemeName.replace(/[^a-zA-Z0-9]/g, '_').toUpperCase()}`];
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
                    const token = process.env.OMNIDIM_API_KEY || process.env[`BEARER_TOKEN_${schemeName.replace(/[^a-zA-Z0-9]/g, '_').toUpperCase()}`];
                    if (token) {
                        headers['authorization'] = `Bearer ${token}`;
                        if (process.env.OMNIDIM_DEBUG) console.error(`Applied Bearer token for '${schemeName}'`);
                    }
                } 
                else if (scheme.scheme?.toLowerCase() === 'basic') {
                    const username = process.env[`BASIC_USERNAME_${schemeName.replace(/[^a-zA-Z0-9]/g, '_').toUpperCase()}`];
                    const password = process.env[`BASIC_PASSWORD_${schemeName.replace(/[^a-zA-Z0-9]/g, '_').toUpperCase()}`];
                    if (username && password) {
                        headers['authorization'] = `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`;
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
        return {
            content: [{
                type: 'text',
                text: `OMNIDIM_API_KEY is not set. Configure it in your MCP client's "env" block, then restart the client. Get a key at https://omnidim.io/api-management.`,
            }],
        };
    }
    

    // Prepare the axios request configuration
    headers['user-agent'] = `${SERVER_NAME}-mcp-server/${SERVER_VERSION}`;
    const config: AxiosRequestConfig = {
      method: definition.method.toUpperCase(),
      url: requestUrl,
      params: queryParams,
      headers: headers,
      timeout: 60_000,
      ...(requestBodyData !== undefined && { data: requestBodyData }),
    };

    if (process.env.OMNIDIM_DEBUG) {
        console.error(`Executing tool "${toolName}": ${config.method} ${config.url}`);
    }
    
    // Execute the request
    const response = await axios(config);

    // Process and format the response
    let responseText = '';
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
    return { 
        content: [ 
            { 
                type: "text", 
                text: `API Response (Status: ${response.status}):\n${responseText}` 
            } 
        ], 
    };

  } catch (error: unknown) {
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
    return { content: [{ type: "text", text: errorMessage }] };
  }
}


/**
 * Main function to start the server
 */
async function main() {
// Set up stdio transport
  try {
    const transport = new StdioServerTransport();
    await server.connect(transport);
    console.error(`${SERVER_NAME} MCP Server (v${SERVER_VERSION}) running on stdio${API_BASE_URL ? `, proxying API at ${API_BASE_URL}` : ''}`);
  } catch (error) {
    console.error("Error during server startup:", error);
    process.exit(1);
  }
}

/**
 * Cleanup function for graceful shutdown
 */
async function cleanup() {
    console.error("Shutting down MCP server...");
    process.exit(0);
}

// Register signal handlers
process.on('SIGINT', cleanup);
process.on('SIGTERM', cleanup);

// Start the server
main().catch((error) => {
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
