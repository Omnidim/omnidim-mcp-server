#!/usr/bin/env node
/**
 * OmniDimension MCP server.
 */
import { readApiKey } from "./credentials.js";
import { isInteractive, printInteractiveHelp, startupBanner, trimLargeResponse } from "./helpers.js";
import { beginSession, emitSessionCrash, emitSessionEnd, endSession, recordToolError, recordToolResult } from "./telemetry.js";
import { registerProcedures } from "./procedures.js";
import { toolAnnotations } from "./tool-annotations.js";
import { addShowWorkflow, toolMeta } from "./workflow-canvas.js";
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
export const SERVER_VERSION = "0.16.1";
// Base URL for the API. Pinned to production; not env-overridable.
export const API_BASE_URL = "https://omnidim.io/api/v1";

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
    inputSchema: {"type":"object","properties":{"requestBody":{"type":"object","required":["agent_id","type"],"properties":{"agent_id":{"type":"number","description":"ID of the agent the session talks to."},"type":{"type":"string","default":"voice","enum":["voice"],"description":"The session type. Only `voice` is supported."},"custom_variables":{"type":"object","additionalProperties":true,"description":"Per-session variables that personalize the conversation.\nSet server-side, so visitors cannot tamper with them.\nTwo reserved keys are read as instructions for this session\nand never reach the agent: `__languages` and\n`__post_call_actions`.\n","properties":{"__languages":{"oneOf":[{"type":"array","items":{"type":"string"}},{"type":"string"}],"description":"Languages this session runs in, replacing the agent's\nconfigured list. The first entry is the language the\nvisitor is greeted in. Send an array, or a pipe-separated\nstring such as `Hindi|English`.\n"},"__post_call_actions":{"allOf":[{"type":"object","description":"Side effects that fire once the call ends: email, webhook, Omni CRM,\nCloud WhatsApp, a workflow, Google Sheets, Slack, Salesforce, HubSpot\nor Zoho Bigin.\n","properties":{"email":{"type":"object","properties":{"enabled":{"type":"boolean"},"recipients":{"type":"array","description":"Email addresses that should receive the notification.","items":{"type":"string","format":"email"},"example":["support@example.com"]},"include":{"type":"array","description":"Which sections to include in the email body.","items":{"type":"string","enum":["summary","extracted_variables","fullConversation","sentiment"]}},"extracted_variables":{"type":"array","description":"Variables the model should pull out of the conversation for the email.","items":{"type":"object","required":["key","prompt"],"properties":{"key":{"type":"string","description":"Unique identifier for the variable in the post-call payload.","example":"customer_issue"},"prompt":{"type":"string","description":"Instruction for the model on what to pull out of the conversation.","example":"Identify the main issue the customer is experiencing."}}}},"trigger_call_statuses":{"type":"array","description":"Call outcomes that should fire this action. Omit to\nuse the default (`completed`, `voicemail_detected`).\nPass an explicit list to also include failed calls,\nno-answers, busy signals, etc.\n","items":{"type":"string","enum":["completed","voicemail_detected","failed","no-answer","busy","canceled"]},"example":["completed","voicemail_detected"]}}},"webhook":{"type":"object","properties":{"enabled":{"type":"boolean"},"url":{"type":"string","format":"uri","description":"Endpoint that receives a POST with the call payload.","example":"https://your-webhook-endpoint.com/omnidim-callback"},"include":{"type":"array","description":"Which sections to include in the webhook body.","items":{"type":"string","enum":["summary","extracted_variables","fullConversation","sentiment"]}},"extracted_variables":{"type":"array","description":"Variables the model should pull out of the conversation for the webhook.","items":{"type":"object","required":["key","prompt"],"properties":{"key":{"type":"string","description":"Unique identifier for the variable in the post-call payload.","example":"customer_issue"},"prompt":{"type":"string","description":"Instruction for the model on what to pull out of the conversation.","example":"Identify the main issue the customer is experiencing."}}}},"trigger_call_statuses":{"type":"array","description":"Call outcomes that should fire this webhook. Omit to\nuse the default (`completed`, `voicemail_detected`).\n","items":{"type":"string","enum":["completed","voicemail_detected","failed","no-answer","busy","canceled"]},"example":["completed","failed"]}}},"omni_crm":{"allOf":[{"type":"object","description":"Settings every post-call channel shares.","properties":{"enabled":{"type":"boolean"},"include":{"type":"array","description":"Which sections to include in this action.","items":{"type":"string","enum":["summary","extracted_variables","fullConversation","sentiment"]}},"extracted_variables":{"type":"array","description":"Variables the model should pull out of the conversation for this action.","items":{"type":"object","required":["key","prompt"],"properties":{"key":{"type":"string","description":"Unique identifier for the variable in the post-call payload.","example":"customer_issue"},"prompt":{"type":"string","description":"Instruction for the model on what to pull out of the conversation.","example":"Identify the main issue the customer is experiencing."}}}},"trigger_call_statuses":{"type":"array","description":"Call outcomes that fire this action. Omit to use the default\n(`completed`, `voicemail_detected`).\n","items":{"type":"string","enum":["completed","voicemail_detected","failed","no-answer","busy","canceled"]}}}},{"type":"object","description":"Save the call to Omni CRM."}]},"cloud_whatsapp":{"allOf":[{"type":"object","description":"Settings every post-call channel shares.","properties":{"enabled":{"type":"boolean"},"include":{"type":"array","description":"Which sections to include in this action.","items":{"type":"string","enum":["summary","extracted_variables","fullConversation","sentiment"]}},"extracted_variables":{"type":"array","description":"Variables the model should pull out of the conversation for this action.","items":{"type":"object","required":["key","prompt"],"properties":{"key":{"type":"string","description":"Unique identifier for the variable in the post-call payload.","example":"customer_issue"},"prompt":{"type":"string","description":"Instruction for the model on what to pull out of the conversation.","example":"Identify the main issue the customer is experiencing."}}}},"trigger_call_statuses":{"type":"array","description":"Call outcomes that fire this action. Omit to use the default\n(`completed`, `voicemail_detected`).\n","items":{"type":"string","enum":["completed","voicemail_detected","failed","no-answer","busy","canceled"]}}}},{"type":"object","description":"Send a Cloud WhatsApp template message after the call.","properties":{"phone_number_id":{"type":"integer","description":"The id of your organization's Cloud WhatsApp number the\nmessage is sent from.\n"},"template_id":{"type":"integer","description":"An approved template on that number. A template that is not\napproved, or that belongs to another number, is refused.\n"},"template_variables":{"type":"array","description":"Which extracted variable fills each template placeholder.","items":{"type":"object","properties":{"index":{"type":"string","description":"The placeholder number, as a string.","example":"1"},"extracted_var":{"type":"string","description":"The key of the extracted variable whose value fills this placeholder.","example":"customer_name"}}}},"templates":{"type":"array","description":"One or more templates to send, each with its variable mapping.","items":{"type":"object","description":"One Cloud WhatsApp template to send after the call.","properties":{"template_id":{"type":"integer","description":"An approved template on the chosen number."},"usage_description":{"type":"string","description":"When this template should be sent. After the call, the model reads\nthese descriptions to choose which templates fit the conversation.\n","example":"Send when the caller books an appointment."},"always_send":{"type":"boolean","description":"Send this template after every call, whichever templates the model chooses."},"variable_mappings":{"type":"array","description":"How to fill each template placeholder.","items":{"type":"object","properties":{"index":{"type":"string","description":"The placeholder number, as a string.","example":"1"},"extracted_var":{"type":"string","description":"The extracted variable whose value fills this placeholder."},"static_value":{"type":"string","description":"A fixed value for this placeholder. When set, it is used\ninstead of the extracted variable.\n"},"mode":{"type":"string","enum":["variable","static"],"description":"Which input the dashboard shows for this placeholder. It\ndoes not change the value sent: a `static_value` is used\nfirst, then the extracted variable, then `fallback_value`.\n"},"fallback_value":{"type":"string","description":"The value to use when the variable is not extracted."}}}}}}}}}]},"workflow":{"allOf":[{"type":"object","description":"Settings every post-call channel shares.","properties":{"enabled":{"type":"boolean"},"include":{"type":"array","description":"Which sections to include in this action.","items":{"type":"string","enum":["summary","extracted_variables","fullConversation","sentiment"]}},"extracted_variables":{"type":"array","description":"Variables the model should pull out of the conversation for this action.","items":{"type":"object","required":["key","prompt"],"properties":{"key":{"type":"string","description":"Unique identifier for the variable in the post-call payload.","example":"customer_issue"},"prompt":{"type":"string","description":"Instruction for the model on what to pull out of the conversation.","example":"Identify the main issue the customer is experiencing."}}}},"trigger_call_statuses":{"type":"array","description":"Call outcomes that fire this action. Omit to use the default\n(`completed`, `voicemail_detected`).\n","items":{"type":"string","enum":["completed","voicemail_detected","failed","no-answer","busy","canceled"]}}}},{"type":"object","description":"Trigger a workflow after the call.","properties":{"workflow_id":{"type":"integer","description":"The id of the workflow to run."}}}]},"google_sheets":{"allOf":[{"type":"object","description":"Settings every post-call channel shares.","properties":{"enabled":{"type":"boolean"},"include":{"type":"array","description":"Which sections to include in this action.","items":{"type":"string","enum":["summary","extracted_variables","fullConversation","sentiment"]}},"extracted_variables":{"type":"array","description":"Variables the model should pull out of the conversation for this action.","items":{"type":"object","required":["key","prompt"],"properties":{"key":{"type":"string","description":"Unique identifier for the variable in the post-call payload.","example":"customer_issue"},"prompt":{"type":"string","description":"Instruction for the model on what to pull out of the conversation.","example":"Identify the main issue the customer is experiencing."}}}},"trigger_call_statuses":{"type":"array","description":"Call outcomes that fire this action. Omit to use the default\n(`completed`, `voicemail_detected`).\n","items":{"type":"string","enum":["completed","voicemail_detected","failed","no-answer","busy","canceled"]}}}},{"type":"object","description":"Append the call to a Google Sheet. Sending this key replaces the\nagent's Google Sheets actions; leaving it out keeps them.\n","properties":{"integration_id":{"type":"integer","description":"Required. The id of your Google Sheets integration."},"spreadsheet_id":{"type":"string","description":"Required. The id in the sheet's URL, the part after `/d/`."},"spreadsheet_name":{"type":"string"},"worksheet_name":{"type":"string","description":"The tab to append to. Defaults to `Sheet1`."}}}]},"slack":{"allOf":[{"type":"object","description":"Settings every post-call channel shares.","properties":{"enabled":{"type":"boolean"},"include":{"type":"array","description":"Which sections to include in this action.","items":{"type":"string","enum":["summary","extracted_variables","fullConversation","sentiment"]}},"extracted_variables":{"type":"array","description":"Variables the model should pull out of the conversation for this action.","items":{"type":"object","required":["key","prompt"],"properties":{"key":{"type":"string","description":"Unique identifier for the variable in the post-call payload.","example":"customer_issue"},"prompt":{"type":"string","description":"Instruction for the model on what to pull out of the conversation.","example":"Identify the main issue the customer is experiencing."}}}},"trigger_call_statuses":{"type":"array","description":"Call outcomes that fire this action. Omit to use the default\n(`completed`, `voicemail_detected`).\n","items":{"type":"string","enum":["completed","voicemail_detected","failed","no-answer","busy","canceled"]}}}},{"type":"object","description":"Post the call to a Slack channel. Sending this key replaces the\nagent's Slack actions; leaving it out keeps them.\n","properties":{"integration_id":{"type":"integer","description":"Required. The id of your Slack integration."},"channel_id":{"type":"string","description":"The channel id. Send this or `channel_name`."},"channel_name":{"type":"string","description":"The channel name. Send this or `channel_id`."}}}]},"salesforce":{"allOf":[{"type":"object","description":"Settings every post-call channel shares.","properties":{"enabled":{"type":"boolean"},"include":{"type":"array","description":"Which sections to include in this action.","items":{"type":"string","enum":["summary","extracted_variables","fullConversation","sentiment"]}},"extracted_variables":{"type":"array","description":"Variables the model should pull out of the conversation for this action.","items":{"type":"object","required":["key","prompt"],"properties":{"key":{"type":"string","description":"Unique identifier for the variable in the post-call payload.","example":"customer_issue"},"prompt":{"type":"string","description":"Instruction for the model on what to pull out of the conversation.","example":"Identify the main issue the customer is experiencing."}}}},"trigger_call_statuses":{"type":"array","description":"Call outcomes that fire this action. Omit to use the default\n(`completed`, `voicemail_detected`).\n","items":{"type":"string","enum":["completed","voicemail_detected","failed","no-answer","busy","canceled"]}}}},{"type":"object","description":"Create a Salesforce record from the call. Sends a fixed set of\nfields for the object, so it takes no `extracted_variables`.\nSending this key replaces the agent's Salesforce actions;\nleaving it out keeps them.\n","properties":{"integration_id":{"type":"integer","description":"Required. The id of your Salesforce integration."},"object_name":{"type":"string","enum":["Lead","Contact","Account","Opportunity","Case","Task","Product"],"description":"Defaults to `Lead`."}}}]},"hubspot":{"allOf":[{"type":"object","description":"Settings every post-call channel shares.","properties":{"enabled":{"type":"boolean"},"include":{"type":"array","description":"Which sections to include in this action.","items":{"type":"string","enum":["summary","extracted_variables","fullConversation","sentiment"]}},"extracted_variables":{"type":"array","description":"Variables the model should pull out of the conversation for this action.","items":{"type":"object","required":["key","prompt"],"properties":{"key":{"type":"string","description":"Unique identifier for the variable in the post-call payload.","example":"customer_issue"},"prompt":{"type":"string","description":"Instruction for the model on what to pull out of the conversation.","example":"Identify the main issue the customer is experiencing."}}}},"trigger_call_statuses":{"type":"array","description":"Call outcomes that fire this action. Omit to use the default\n(`completed`, `voicemail_detected`).\n","items":{"type":"string","enum":["completed","voicemail_detected","failed","no-answer","busy","canceled"]}}}},{"type":"object","description":"Create a HubSpot record from the call. Sends a fixed set of\nfields for the object, so it takes no `extracted_variables`.\nSending this key replaces the agent's HubSpot actions; leaving\nit out keeps them.\n","properties":{"integration_id":{"type":"integer","description":"Required. The id of your HubSpot integration."},"object_name":{"type":"string","enum":["contact","company","deal","ticket"],"description":"Required."}}}]},"zoho_bigin":{"allOf":[{"type":"object","description":"Settings every post-call channel shares.","properties":{"enabled":{"type":"boolean"},"include":{"type":"array","description":"Which sections to include in this action.","items":{"type":"string","enum":["summary","extracted_variables","fullConversation","sentiment"]}},"extracted_variables":{"type":"array","description":"Variables the model should pull out of the conversation for this action.","items":{"type":"object","required":["key","prompt"],"properties":{"key":{"type":"string","description":"Unique identifier for the variable in the post-call payload.","example":"customer_issue"},"prompt":{"type":"string","description":"Instruction for the model on what to pull out of the conversation.","example":"Identify the main issue the customer is experiencing."}}}},"trigger_call_statuses":{"type":"array","description":"Call outcomes that fire this action. Omit to use the default\n(`completed`, `voicemail_detected`).\n","items":{"type":"string","enum":["completed","voicemail_detected","failed","no-answer","busy","canceled"]}}}},{"type":"object","description":"Log the call in Zoho Bigin. Sending this key replaces the\nagent's Zoho Bigin actions; leaving it out keeps them.\n","properties":{"integration_id":{"type":"integer","description":"Required. The id of your Zoho Bigin integration."},"create_call_log":{"type":"boolean","description":"Log the call. Defaults to true."},"update_contact":{"type":"boolean","description":"Update a matching contact with what the call captured. Defaults to true."},"create_contact":{"type":"boolean","description":"Create a contact when no contact matches. Defaults to true."}}}]}}}],"description":"Post-call actions for this session only, in the same shape\nas `post_call_actions` on agent create. Email and webhook\nonly. They replace the agent's own post-call actions for\nthis session. Items that cannot be used are skipped and\nlisted in `post_call_actions_ignored`.\n"}}},"metadata":{"type":"object","additionalProperties":true,"description":"Key-value pairs stored on the session for your own\ntracking (e.g. CRM or lead IDs). Not shared with the\nagent; echoed back as `metadata` in the post-call\nwebhook so you can correlate results with your records.\n"}},"description":"The JSON request body."}},"required":["requestBody"]},
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
end-call conditions, post-call actions (email, webhook, Omni CRM,
Cloud WhatsApp, or a workflow),
ambient background track, initial ringing sound, and multilingual support.

> **Voicemail detection is an access-gated feature** that we turn on per
account. If it isn't enabled for yours yet,
[request access](https://omnidim.io/contact-us?reason=product&lock=1)
before configuring the \`voicemail\` object.

(Tags: Agents)`,
    inputSchema: {"type":"object","properties":{"Idempotency-Key":{"type":"string","maxLength":255,"description":"Your own unique key for this agent, for example a fresh UUID.\nSend the same key when you retry. If the first request already\ncreated the agent, you get that agent back instead of a second\none, so a request that timed out is safe to repeat. The same key\nwith a different request body is refused. Keys are kept for 24\nhours.\n"},"requestBody":{"allOf":[{"type":"object","description":"Agent configuration.","properties":{"name":{"type":"string","description":"Name for the agent.","example":"Customer Support Agent"},"welcome_message":{"type":"string","description":"Initial message the agent will say when answering a call.","example":"Hello! How can I help you today?"},"is_welcome_message_dynamic":{"type":"boolean","description":"When true, the welcome message is treated as a directive the agent uses to generate a tailored greeting for each call, rather than being spoken word for word. When false, the welcome message is spoken exactly as written."},"is_welcome_message_interruption":{"type":"boolean","description":"Allow the caller to interrupt the welcome message. When false, the agent finishes speaking the welcome before listening."},"is_interruption_allowed":{"type":"boolean","description":"Global toggle for whether the caller can interrupt the agent mid-sentence at any point in the call."},"dynamic_variables":{"type":"object","description":"Key/value map used to substitute placeholders in the agent's\nprompt and welcome message at call time. Reference a variable\nin your prompt with `{{variable_name}}`. Useful for\npersonalising the same agent across many calls.\n","additionalProperties":{"type":"string"},"example":{"customer_name":"Jane Doe","order_id":"ORD-12345"}},"context_breakdown":{"type":"array","description":"List of context breakdowns, each containing `title`, `body`, and optional `is_enabled`.","items":{"type":"object","required":["title","body"],"properties":{"title":{"type":"string","description":"Title of the breakdown.","example":"Purpose"},"body":{"type":"string","description":"Body of the breakdown, the detailed prompt content.","example":"This agent helps customers with product inquiries and support issues."},"is_enabled":{"type":"boolean","default":true,"description":"Whether this section is included in the prompt."}}}},"call_type":{"type":"string","enum":["Incoming","Outgoing"],"description":"Call type of the assistant."},"timezone":{"type":"string","description":"IANA timezone for this agent, for example `Asia/Kolkata`. Sets the local date and time the agent works with during calls. If not set, the account timezone is used as fallback. Pass an empty string to clear it.","example":"America/New_York"},"transcriber":{"type":"object","description":"Configuration for the speech-to-text transcriber.","properties":{"provider":{"type":"string","enum":["deepgram_stream","cartesia","sarvam","azure_stream","soniox"],"description":"The speech-to-text provider to use.","example":"deepgram_stream"},"model":{"type":"string","description":"Transcription model for the selected provider. For\n`deepgram_stream` this is `nova-3` or `nova-2`; other\nproviders take their own model identifiers.\n","example":"nova-3"},"language":{"type":"string","description":"Language code for the transcriber. Format and supported\nvalues depend on the provider (e.g. `en-US` for Deepgram,\n`hi-IN` for Sarvam). Applies regardless of which\n`provider` is selected.\n","example":"en-US"},"silence_timeout_ms":{"type":"integer","description":"Silence timeout in milliseconds.","example":400},"should_apply_noise_reduction":{"type":"boolean","description":"Reduce background noise on the inbound audio stream before transcription."},"interruption_min_words":{"type":"integer","minimum":1,"description":"Minimum number of words the caller must say before their speech is treated as an interruption.","example":2},"max_call_duration_in_sec":{"type":"integer","minimum":1,"description":"Hard upper bound on call length in seconds. The agent will end the call once this is reached.","example":600},"first_ideal_message":{"type":"string","description":"First nudge spoken when the caller goes silent past the\nidle threshold. Set `is_first_ideal_message_dynamic` to\n`true` to have the LLM regenerate this each time.\n"},"is_first_ideal_message_dynamic":{"type":"boolean","description":"When true, `first_ideal_message` is treated as a prompt and the LLM generates a fresh nudge each call."},"second_ideal_message":{"type":"string","description":"Second nudge spoken if silence continues after the first."},"is_second_ideal_message_dynamic":{"type":"boolean","description":"When true, `second_ideal_message` is treated as a prompt and the LLM generates a fresh nudge each call."},"numerals":{"type":"boolean","description":"Convert numbers from words to digits."},"punctuate":{"type":"boolean","description":"Add punctuation to the transcript."},"smart_format":{"type":"boolean","description":"Apply smart formatting to the transcript."},"diarize":{"type":"boolean","description":"Identify different speakers in the transcript."}}},"model":{"type":"object","description":"Configuration for the language model.","properties":{"model":{"type":"string","enum":["azure-gpt-4.1-mini","azure-gpt-4.1-nano","azure-gpt-4o","azure-gpt-4o-mini","gemini-2.5-flash","gemini-2.5-flash-lite","gpt-3.5-turbo","gpt-4.1-mini","gpt-4.1-nano","gpt-4o","gpt-4o-mini","gpt-5.1","llama-3.3-70b-versatile"],"description":"The language model to use. The current catalog is returned by the LLM providers list.","example":"gpt-4.1-mini"},"temperature":{"type":"number","minimum":0,"maximum":1,"description":"Controls randomness in the model's output (0.0 to 1.0).","example":0.7}}},"voice":{"type":"object","description":"Configuration for the text-to-speech voice. `provider` and `voice_id` identify the voice together, so send both to change it. `provider` on its own is not accepted, and a `voice_id` on its own leaves the voice as it was. The other fields here apply independently.","dependentRequired":{"provider":["voice_id"]},"properties":{"provider":{"type":"string","enum":["eleven_labs","google","cartesia","sarvam"],"description":"The voice provider to use. The current catalog is returned by the TTS providers list. Send `voice_id` alongside it.","example":"eleven_labs"},"voice_id":{"type":"string","description":"The provider's voice identifier, returned in the `name` field of the voices list (not the numeric `id`). Takes effect when `provider` is sent alongside it.","example":"JBFqnCBsd6RMkjVDRZzb"},"speech_speed":{"type":"number","minimum":0.5,"maximum":2,"default":1,"description":"Playback speed multiplier for the agent's voice. 1.0 is normal speed."}}},"web_search":{"type":"object","description":"Configuration for web search capabilities.","properties":{"enabled":{"type":"boolean","description":"Enable or disable web search functionality."},"provider":{"type":"string","enum":["DuckDuckGo","openAI"],"description":"The search provider to use.","example":"DuckDuckGo"}}},"post_call_actions":{"type":"object","description":"Side effects that fire once the call ends: email, webhook, Omni CRM,\nCloud WhatsApp, a workflow, Google Sheets, Slack, Salesforce, HubSpot\nor Zoho Bigin.\n","properties":{"email":{"type":"object","properties":{"enabled":{"type":"boolean"},"recipients":{"type":"array","description":"Email addresses that should receive the notification.","items":{"type":"string","format":"email"},"example":["support@example.com"]},"include":{"type":"array","description":"Which sections to include in the email body.","items":{"type":"string","enum":["summary","extracted_variables","fullConversation","sentiment"]}},"extracted_variables":{"type":"array","description":"Variables the model should pull out of the conversation for the email.","items":{"type":"object","required":["key","prompt"],"properties":{"key":{"type":"string","description":"Unique identifier for the variable in the post-call payload.","example":"customer_issue"},"prompt":{"type":"string","description":"Instruction for the model on what to pull out of the conversation.","example":"Identify the main issue the customer is experiencing."}}}},"trigger_call_statuses":{"type":"array","description":"Call outcomes that should fire this action. Omit to\nuse the default (`completed`, `voicemail_detected`).\nPass an explicit list to also include failed calls,\nno-answers, busy signals, etc.\n","items":{"type":"string","enum":["completed","voicemail_detected","failed","no-answer","busy","canceled"]},"example":["completed","voicemail_detected"]}}},"webhook":{"type":"object","properties":{"enabled":{"type":"boolean"},"url":{"type":"string","format":"uri","description":"Endpoint that receives a POST with the call payload.","example":"https://your-webhook-endpoint.com/omnidim-callback"},"include":{"type":"array","description":"Which sections to include in the webhook body.","items":{"type":"string","enum":["summary","extracted_variables","fullConversation","sentiment"]}},"extracted_variables":{"type":"array","description":"Variables the model should pull out of the conversation for the webhook.","items":{"type":"object","required":["key","prompt"],"properties":{"key":{"type":"string","description":"Unique identifier for the variable in the post-call payload.","example":"customer_issue"},"prompt":{"type":"string","description":"Instruction for the model on what to pull out of the conversation.","example":"Identify the main issue the customer is experiencing."}}}},"trigger_call_statuses":{"type":"array","description":"Call outcomes that should fire this webhook. Omit to\nuse the default (`completed`, `voicemail_detected`).\n","items":{"type":"string","enum":["completed","voicemail_detected","failed","no-answer","busy","canceled"]},"example":["completed","failed"]}}},"omni_crm":{"allOf":[{"type":"object","description":"Settings every post-call channel shares.","properties":{"enabled":{"type":"boolean"},"include":{"type":"array","description":"Which sections to include in this action.","items":{"type":"string","enum":["summary","extracted_variables","fullConversation","sentiment"]}},"extracted_variables":{"type":"array","description":"Variables the model should pull out of the conversation for this action.","items":{"type":"object","required":["key","prompt"],"properties":{"key":{"type":"string","description":"Unique identifier for the variable in the post-call payload.","example":"customer_issue"},"prompt":{"type":"string","description":"Instruction for the model on what to pull out of the conversation.","example":"Identify the main issue the customer is experiencing."}}}},"trigger_call_statuses":{"type":"array","description":"Call outcomes that fire this action. Omit to use the default\n(`completed`, `voicemail_detected`).\n","items":{"type":"string","enum":["completed","voicemail_detected","failed","no-answer","busy","canceled"]}}}},{"type":"object","description":"Save the call to Omni CRM."}]},"cloud_whatsapp":{"allOf":[{"type":"object","description":"Settings every post-call channel shares.","properties":{"enabled":{"type":"boolean"},"include":{"type":"array","description":"Which sections to include in this action.","items":{"type":"string","enum":["summary","extracted_variables","fullConversation","sentiment"]}},"extracted_variables":{"type":"array","description":"Variables the model should pull out of the conversation for this action.","items":{"type":"object","required":["key","prompt"],"properties":{"key":{"type":"string","description":"Unique identifier for the variable in the post-call payload.","example":"customer_issue"},"prompt":{"type":"string","description":"Instruction for the model on what to pull out of the conversation.","example":"Identify the main issue the customer is experiencing."}}}},"trigger_call_statuses":{"type":"array","description":"Call outcomes that fire this action. Omit to use the default\n(`completed`, `voicemail_detected`).\n","items":{"type":"string","enum":["completed","voicemail_detected","failed","no-answer","busy","canceled"]}}}},{"type":"object","description":"Send a Cloud WhatsApp template message after the call.","properties":{"phone_number_id":{"type":"integer","description":"The id of your organization's Cloud WhatsApp number the\nmessage is sent from.\n"},"template_id":{"type":"integer","description":"An approved template on that number. A template that is not\napproved, or that belongs to another number, is refused.\n"},"template_variables":{"type":"array","description":"Which extracted variable fills each template placeholder.","items":{"type":"object","properties":{"index":{"type":"string","description":"The placeholder number, as a string.","example":"1"},"extracted_var":{"type":"string","description":"The key of the extracted variable whose value fills this placeholder.","example":"customer_name"}}}},"templates":{"type":"array","description":"One or more templates to send, each with its variable mapping.","items":{"type":"object","description":"One Cloud WhatsApp template to send after the call.","properties":{"template_id":{"type":"integer","description":"An approved template on the chosen number."},"usage_description":{"type":"string","description":"When this template should be sent. After the call, the model reads\nthese descriptions to choose which templates fit the conversation.\n","example":"Send when the caller books an appointment."},"always_send":{"type":"boolean","description":"Send this template after every call, whichever templates the model chooses."},"variable_mappings":{"type":"array","description":"How to fill each template placeholder.","items":{"type":"object","properties":{"index":{"type":"string","description":"The placeholder number, as a string.","example":"1"},"extracted_var":{"type":"string","description":"The extracted variable whose value fills this placeholder."},"static_value":{"type":"string","description":"A fixed value for this placeholder. When set, it is used\ninstead of the extracted variable.\n"},"mode":{"type":"string","enum":["variable","static"],"description":"Which input the dashboard shows for this placeholder. It\ndoes not change the value sent: a `static_value` is used\nfirst, then the extracted variable, then `fallback_value`.\n"},"fallback_value":{"type":"string","description":"The value to use when the variable is not extracted."}}}}}}}}}]},"workflow":{"allOf":[{"type":"object","description":"Settings every post-call channel shares.","properties":{"enabled":{"type":"boolean"},"include":{"type":"array","description":"Which sections to include in this action.","items":{"type":"string","enum":["summary","extracted_variables","fullConversation","sentiment"]}},"extracted_variables":{"type":"array","description":"Variables the model should pull out of the conversation for this action.","items":{"type":"object","required":["key","prompt"],"properties":{"key":{"type":"string","description":"Unique identifier for the variable in the post-call payload.","example":"customer_issue"},"prompt":{"type":"string","description":"Instruction for the model on what to pull out of the conversation.","example":"Identify the main issue the customer is experiencing."}}}},"trigger_call_statuses":{"type":"array","description":"Call outcomes that fire this action. Omit to use the default\n(`completed`, `voicemail_detected`).\n","items":{"type":"string","enum":["completed","voicemail_detected","failed","no-answer","busy","canceled"]}}}},{"type":"object","description":"Trigger a workflow after the call.","properties":{"workflow_id":{"type":"integer","description":"The id of the workflow to run."}}}]},"google_sheets":{"allOf":[{"type":"object","description":"Settings every post-call channel shares.","properties":{"enabled":{"type":"boolean"},"include":{"type":"array","description":"Which sections to include in this action.","items":{"type":"string","enum":["summary","extracted_variables","fullConversation","sentiment"]}},"extracted_variables":{"type":"array","description":"Variables the model should pull out of the conversation for this action.","items":{"type":"object","required":["key","prompt"],"properties":{"key":{"type":"string","description":"Unique identifier for the variable in the post-call payload.","example":"customer_issue"},"prompt":{"type":"string","description":"Instruction for the model on what to pull out of the conversation.","example":"Identify the main issue the customer is experiencing."}}}},"trigger_call_statuses":{"type":"array","description":"Call outcomes that fire this action. Omit to use the default\n(`completed`, `voicemail_detected`).\n","items":{"type":"string","enum":["completed","voicemail_detected","failed","no-answer","busy","canceled"]}}}},{"type":"object","description":"Append the call to a Google Sheet. Sending this key replaces the\nagent's Google Sheets actions; leaving it out keeps them.\n","properties":{"integration_id":{"type":"integer","description":"Required. The id of your Google Sheets integration."},"spreadsheet_id":{"type":"string","description":"Required. The id in the sheet's URL, the part after `/d/`."},"spreadsheet_name":{"type":"string"},"worksheet_name":{"type":"string","description":"The tab to append to. Defaults to `Sheet1`."}}}]},"slack":{"allOf":[{"type":"object","description":"Settings every post-call channel shares.","properties":{"enabled":{"type":"boolean"},"include":{"type":"array","description":"Which sections to include in this action.","items":{"type":"string","enum":["summary","extracted_variables","fullConversation","sentiment"]}},"extracted_variables":{"type":"array","description":"Variables the model should pull out of the conversation for this action.","items":{"type":"object","required":["key","prompt"],"properties":{"key":{"type":"string","description":"Unique identifier for the variable in the post-call payload.","example":"customer_issue"},"prompt":{"type":"string","description":"Instruction for the model on what to pull out of the conversation.","example":"Identify the main issue the customer is experiencing."}}}},"trigger_call_statuses":{"type":"array","description":"Call outcomes that fire this action. Omit to use the default\n(`completed`, `voicemail_detected`).\n","items":{"type":"string","enum":["completed","voicemail_detected","failed","no-answer","busy","canceled"]}}}},{"type":"object","description":"Post the call to a Slack channel. Sending this key replaces the\nagent's Slack actions; leaving it out keeps them.\n","properties":{"integration_id":{"type":"integer","description":"Required. The id of your Slack integration."},"channel_id":{"type":"string","description":"The channel id. Send this or `channel_name`."},"channel_name":{"type":"string","description":"The channel name. Send this or `channel_id`."}}}]},"salesforce":{"allOf":[{"type":"object","description":"Settings every post-call channel shares.","properties":{"enabled":{"type":"boolean"},"include":{"type":"array","description":"Which sections to include in this action.","items":{"type":"string","enum":["summary","extracted_variables","fullConversation","sentiment"]}},"extracted_variables":{"type":"array","description":"Variables the model should pull out of the conversation for this action.","items":{"type":"object","required":["key","prompt"],"properties":{"key":{"type":"string","description":"Unique identifier for the variable in the post-call payload.","example":"customer_issue"},"prompt":{"type":"string","description":"Instruction for the model on what to pull out of the conversation.","example":"Identify the main issue the customer is experiencing."}}}},"trigger_call_statuses":{"type":"array","description":"Call outcomes that fire this action. Omit to use the default\n(`completed`, `voicemail_detected`).\n","items":{"type":"string","enum":["completed","voicemail_detected","failed","no-answer","busy","canceled"]}}}},{"type":"object","description":"Create a Salesforce record from the call. Sends a fixed set of\nfields for the object, so it takes no `extracted_variables`.\nSending this key replaces the agent's Salesforce actions;\nleaving it out keeps them.\n","properties":{"integration_id":{"type":"integer","description":"Required. The id of your Salesforce integration."},"object_name":{"type":"string","enum":["Lead","Contact","Account","Opportunity","Case","Task","Product"],"description":"Defaults to `Lead`."}}}]},"hubspot":{"allOf":[{"type":"object","description":"Settings every post-call channel shares.","properties":{"enabled":{"type":"boolean"},"include":{"type":"array","description":"Which sections to include in this action.","items":{"type":"string","enum":["summary","extracted_variables","fullConversation","sentiment"]}},"extracted_variables":{"type":"array","description":"Variables the model should pull out of the conversation for this action.","items":{"type":"object","required":["key","prompt"],"properties":{"key":{"type":"string","description":"Unique identifier for the variable in the post-call payload.","example":"customer_issue"},"prompt":{"type":"string","description":"Instruction for the model on what to pull out of the conversation.","example":"Identify the main issue the customer is experiencing."}}}},"trigger_call_statuses":{"type":"array","description":"Call outcomes that fire this action. Omit to use the default\n(`completed`, `voicemail_detected`).\n","items":{"type":"string","enum":["completed","voicemail_detected","failed","no-answer","busy","canceled"]}}}},{"type":"object","description":"Create a HubSpot record from the call. Sends a fixed set of\nfields for the object, so it takes no `extracted_variables`.\nSending this key replaces the agent's HubSpot actions; leaving\nit out keeps them.\n","properties":{"integration_id":{"type":"integer","description":"Required. The id of your HubSpot integration."},"object_name":{"type":"string","enum":["contact","company","deal","ticket"],"description":"Required."}}}]},"zoho_bigin":{"allOf":[{"type":"object","description":"Settings every post-call channel shares.","properties":{"enabled":{"type":"boolean"},"include":{"type":"array","description":"Which sections to include in this action.","items":{"type":"string","enum":["summary","extracted_variables","fullConversation","sentiment"]}},"extracted_variables":{"type":"array","description":"Variables the model should pull out of the conversation for this action.","items":{"type":"object","required":["key","prompt"],"properties":{"key":{"type":"string","description":"Unique identifier for the variable in the post-call payload.","example":"customer_issue"},"prompt":{"type":"string","description":"Instruction for the model on what to pull out of the conversation.","example":"Identify the main issue the customer is experiencing."}}}},"trigger_call_statuses":{"type":"array","description":"Call outcomes that fire this action. Omit to use the default\n(`completed`, `voicemail_detected`).\n","items":{"type":"string","enum":["completed","voicemail_detected","failed","no-answer","busy","canceled"]}}}},{"type":"object","description":"Log the call in Zoho Bigin. Sending this key replaces the\nagent's Zoho Bigin actions; leaving it out keeps them.\n","properties":{"integration_id":{"type":"integer","description":"Required. The id of your Zoho Bigin integration."},"create_call_log":{"type":"boolean","description":"Log the call. Defaults to true."},"update_contact":{"type":"boolean","description":"Update a matching contact with what the call captured. Defaults to true."},"create_contact":{"type":"boolean","description":"Create a contact when no contact matches. Defaults to true."}}}]}}},"transfer":{"type":"object","description":"Conditional call transfer to a human agent or another number.","properties":{"enabled":{"type":"boolean"},"transfer_options":{"type":"array","description":"Where to transfer the call and under what condition. The first matching condition wins. In an agent update, sending this list replaces all saved options. Omit it to keep them unchanged, or send an empty array to clear them.","items":{"type":"object","required":["number","transfer_condition","transfer_message"],"properties":{"number":{"type":"string","description":"Primary phone number to transfer to. Include country code with leading `+`.","example":"+15551234567"},"type":{"type":"string","enum":["static","dynamic"],"default":"static","description":"`static` transfers to `number`. `dynamic` lets the agent\npick a number at runtime based on the conversation.\n"},"backup_numbers":{"type":"array","description":"Fallback numbers tried if the primary is unreachable.","items":{"type":"string"}},"transfer_condition":{"type":"string","description":"Natural-language condition that triggers this transfer option.","example":"Transfer if the customer asks to speak with a human."},"transfer_message":{"type":"string","description":"Message the agent says to the caller before executing the transfer.","example":"Please hold while I connect you to one of our agents."}}}}}},"end_call":{"type":"object","description":"Hang up automatically when a condition is met.","properties":{"enabled":{"type":"boolean"},"condition":{"type":"string","description":"Natural-language condition that triggers ending the call. Only evaluated when `enabled` is true.","example":"End the call once the customer's issue is resolved."},"message":{"type":"string","description":"What the agent says before hanging up.","example":"Thank you for contacting us. Have a great day!"},"message_type":{"type":"string","enum":["static","prompt"],"description":"`static` speaks `message` verbatim. `prompt` treats\n`message_prompt` as an LLM instruction and generates a\nfresh closing line each call (useful for matching the\ncaller's language and tone).\n"},"message_prompt":{"type":"string","description":"LLM prompt used to generate the closing line when `message_type` is `prompt`.","example":"End the call politely in the same language the user is speaking."}}},"background_track":{"type":"object","description":"Ambient background noise that plays under the agent's voice.","properties":{"enabled":{"type":"boolean","description":"Whether to mix the ambient track under the agent's audio."},"name":{"type":"string","enum":["call_center","filler","office","office_1","restaurant"],"description":"Ambient track to mix under the agent."},"volume":{"type":"number","minimum":0,"maximum":1,"default":0.2,"description":"Volume level on a 0–1 scale. Default 0.2."},"tts_volume_reduction":{"type":"number","minimum":0,"maximum":1,"description":"Amount to drop the agent's TTS volume while the ambient track plays, on a 0–1 scale. Helps the voice cut through without raising the overall mix."}}},"initial_ringing_sound_enabled":{"type":"boolean","description":"Plays a ringing tone after the call is picked up, until the agent starts speaking."},"voicemail":{"type":"object","description":"Voicemail / answering-machine handling for outbound calls. Set this with the nested object shown here; the agent object returns these values as the flat fields `voicemail_enabled` and `voicemail_message`. Voicemail detection is an access-gated feature. If it isn't enabled for your account, [request access](https://omnidim.io/contact-us?reason=product&lock=1).","properties":{"enabled":{"type":"boolean","description":"Detect voicemail and leave your message instead of speaking to a machine."},"message":{"type":"string","description":"Message to leave when voicemail is detected."}}},"languages":{"type":"array","description":"Languages the agent should support. Pass each language as a display-name string exactly as it appears in the dashboard's language picker. Unrecognized names are skipped.","items":{"type":"string"},"example":["English (India)","Hindi"]}}},{"type":"object","required":["name","context_breakdown"]}],"description":"The JSON request body."}},"required":["requestBody"]},
    method: "post",
    pathTemplate: "/agents/create",
    executionParameters: [{"name":"Idempotency-Key","in":"header"}],
    requestBodyContentType: "application/json",
    securityRequirements: [{"BearerAuth":[]}],
    tags: ["Agents"],
    deprecated: false
  }],
  ["getAgent", {
    name: "getAgent",
    description: `Get details of a specific agent by ID. The response also includes a \`can_publish\` boolean showing whether [version history](/docs/api-reference/agents/listAgentVersions) is turned on for the agent's organization.
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

\`post_call_actions\` replaces the agent's email, webhook, Omni CRM, Cloud WhatsApp and workflow actions as one set, but only when you send at least one of those types. Google Sheets, Slack, Salesforce, HubSpot and Zoho Bigin actions are replaced only when their key is sent, and kept otherwise. If a sent action gives a variable key a new prompt, kept actions that use the same key take the new prompt too. To add, change or remove one action without touching the others, use \`/agents/{agent_id}/post-call-actions\`.

> **Voicemail detection is an access-gated feature** that we turn on per account. If it isn't enabled for yours yet, [request access](https://omnidim.io/contact-us?reason=product&lock=1) before configuring the \`voicemail\` object below.
(Tags: Agents)`,
    inputSchema: {"type":"object","properties":{"agent_id":{"type":"number","description":"The ID of the agent."},"requestBody":{"type":"object","description":"Agent configuration.","properties":{"name":{"type":"string","description":"Name for the agent."},"welcome_message":{"type":"string","description":"Initial message the agent will say when answering a call."},"is_welcome_message_dynamic":{"type":"boolean","description":"When true, the welcome message is treated as a directive the agent uses to generate a tailored greeting for each call, rather than being spoken word for word. When false, the welcome message is spoken exactly as written."},"is_welcome_message_interruption":{"type":"boolean","description":"Allow the caller to interrupt the welcome message. When false, the agent finishes speaking the welcome before listening."},"is_interruption_allowed":{"type":"boolean","description":"Global toggle for whether the caller can interrupt the agent mid-sentence at any point in the call."},"dynamic_variables":{"type":"object","description":"Key/value map used to substitute placeholders in the agent's\nprompt and welcome message at call time. Reference a variable\nin your prompt with `{{variable_name}}`. Useful for\npersonalising the same agent across many calls.\n","additionalProperties":{"type":"string"}},"context_breakdown":{"type":"array","description":"List of context breakdowns, each containing `title`, `body`, and optional `is_enabled`.","items":{"type":"object","required":["title","body"],"properties":{"title":{"type":"string","description":"Title of the breakdown."},"body":{"type":"string","description":"Body of the breakdown, the detailed prompt content."},"is_enabled":{"type":"boolean","default":true,"description":"Whether this section is included in the prompt."}}}},"call_type":{"type":"string","enum":["Incoming","Outgoing"],"description":"Call type of the assistant."},"timezone":{"type":"string","description":"IANA timezone for this agent, for example `Asia/Kolkata`. Sets the local date and time the agent works with during calls. If not set, the account timezone is used as fallback. Pass an empty string to clear it."},"transcriber":{"type":"object","description":"Configuration for the speech-to-text transcriber.","properties":{"provider":{"type":"string","enum":["deepgram_stream","cartesia","sarvam","azure_stream","soniox"],"description":"The speech-to-text provider to use."},"model":{"type":"string","description":"Transcription model for the selected provider. For\n`deepgram_stream` this is `nova-3` or `nova-2`; other\nproviders take their own model identifiers.\n"},"language":{"type":"string","description":"Language code for the transcriber. Format and supported\nvalues depend on the provider (e.g. `en-US` for Deepgram,\n`hi-IN` for Sarvam). Applies regardless of which\n`provider` is selected.\n"},"silence_timeout_ms":{"type":"number","description":"Silence timeout in milliseconds."},"should_apply_noise_reduction":{"type":"boolean","description":"Reduce background noise on the inbound audio stream before transcription."},"interruption_min_words":{"type":"number","minimum":1,"description":"Minimum number of words the caller must say before their speech is treated as an interruption."},"max_call_duration_in_sec":{"type":"number","minimum":1,"description":"Hard upper bound on call length in seconds. The agent will end the call once this is reached."},"first_ideal_message":{"type":"string","description":"First nudge spoken when the caller goes silent past the\nidle threshold. Set `is_first_ideal_message_dynamic` to\n`true` to have the LLM regenerate this each time.\n"},"is_first_ideal_message_dynamic":{"type":"boolean","description":"When true, `first_ideal_message` is treated as a prompt and the LLM generates a fresh nudge each call."},"second_ideal_message":{"type":"string","description":"Second nudge spoken if silence continues after the first."},"is_second_ideal_message_dynamic":{"type":"boolean","description":"When true, `second_ideal_message` is treated as a prompt and the LLM generates a fresh nudge each call."},"numerals":{"type":"boolean","description":"Convert numbers from words to digits."},"punctuate":{"type":"boolean","description":"Add punctuation to the transcript."},"smart_format":{"type":"boolean","description":"Apply smart formatting to the transcript."},"diarize":{"type":"boolean","description":"Identify different speakers in the transcript."}}},"model":{"type":"object","description":"Configuration for the language model.","properties":{"model":{"type":"string","enum":["azure-gpt-4.1-mini","azure-gpt-4.1-nano","azure-gpt-4o","azure-gpt-4o-mini","gemini-2.5-flash","gemini-2.5-flash-lite","gpt-3.5-turbo","gpt-4.1-mini","gpt-4.1-nano","gpt-4o","gpt-4o-mini","gpt-5.1","llama-3.3-70b-versatile"],"description":"The language model to use. The current catalog is returned by the LLM providers list."},"temperature":{"type":"number","minimum":0,"maximum":1,"description":"Controls randomness in the model's output (0.0 to 1.0)."}}},"voice":{"type":"object","description":"Configuration for the text-to-speech voice. `provider` and `voice_id` identify the voice together, so send both to change it. `provider` on its own is not accepted, and a `voice_id` on its own leaves the voice as it was. The other fields here apply independently.","dependentRequired":{"provider":["voice_id"]},"properties":{"provider":{"type":"string","enum":["eleven_labs","google","cartesia","sarvam"],"description":"The voice provider to use. The current catalog is returned by the TTS providers list. Send `voice_id` alongside it."},"voice_id":{"type":"string","description":"The provider's voice identifier, returned in the `name` field of the voices list (not the numeric `id`). Takes effect when `provider` is sent alongside it."},"speech_speed":{"type":"number","minimum":0.5,"maximum":2,"default":1,"description":"Playback speed multiplier for the agent's voice. 1.0 is normal speed."}}},"web_search":{"type":"object","description":"Configuration for web search capabilities.","properties":{"enabled":{"type":"boolean","description":"Enable or disable web search functionality."},"provider":{"type":"string","enum":["DuckDuckGo","openAI"],"description":"The search provider to use."}}},"post_call_actions":{"type":"object","description":"Side effects that fire once the call ends: email, webhook, Omni CRM,\nCloud WhatsApp, a workflow, Google Sheets, Slack, Salesforce, HubSpot\nor Zoho Bigin.\n","properties":{"email":{"type":"object","properties":{"enabled":{"type":"boolean"},"recipients":{"type":"array","description":"Email addresses that should receive the notification.","items":{"type":"string","format":"email"}},"include":{"type":"array","description":"Which sections to include in the email body.","items":{"type":"string","enum":["summary","extracted_variables","fullConversation","sentiment"]}},"extracted_variables":{"type":"array","description":"Variables the model should pull out of the conversation for the email.","items":{"type":"object","required":["key","prompt"],"properties":{"key":{"type":"string","description":"Unique identifier for the variable in the post-call payload."},"prompt":{"type":"string","description":"Instruction for the model on what to pull out of the conversation."}}}},"trigger_call_statuses":{"type":"array","description":"Call outcomes that should fire this action. Omit to\nuse the default (`completed`, `voicemail_detected`).\nPass an explicit list to also include failed calls,\nno-answers, busy signals, etc.\n","items":{"type":"string","enum":["completed","voicemail_detected","failed","no-answer","busy","canceled"]}}}},"webhook":{"type":"object","properties":{"enabled":{"type":"boolean"},"url":{"type":"string","format":"uri","description":"Endpoint that receives a POST with the call payload."},"include":{"type":"array","description":"Which sections to include in the webhook body.","items":{"type":"string","enum":["summary","extracted_variables","fullConversation","sentiment"]}},"extracted_variables":{"type":"array","description":"Variables the model should pull out of the conversation for the webhook.","items":{"type":"object","required":["key","prompt"],"properties":{"key":{"type":"string","description":"Unique identifier for the variable in the post-call payload."},"prompt":{"type":"string","description":"Instruction for the model on what to pull out of the conversation."}}}},"trigger_call_statuses":{"type":"array","description":"Call outcomes that should fire this webhook. Omit to\nuse the default (`completed`, `voicemail_detected`).\n","items":{"type":"string","enum":["completed","voicemail_detected","failed","no-answer","busy","canceled"]}}}},"omni_crm":{"allOf":[{"type":"object","description":"Settings every post-call channel shares.","properties":{"enabled":{"type":"boolean"},"include":{"type":"array","description":"Which sections to include in this action.","items":{"type":"string","enum":["summary","extracted_variables","fullConversation","sentiment"]}},"extracted_variables":{"type":"array","description":"Variables the model should pull out of the conversation for this action.","items":{"type":"object","required":["key","prompt"],"properties":{"key":{"type":"string","description":"Unique identifier for the variable in the post-call payload.","example":"customer_issue"},"prompt":{"type":"string","description":"Instruction for the model on what to pull out of the conversation.","example":"Identify the main issue the customer is experiencing."}}}},"trigger_call_statuses":{"type":"array","description":"Call outcomes that fire this action. Omit to use the default\n(`completed`, `voicemail_detected`).\n","items":{"type":"string","enum":["completed","voicemail_detected","failed","no-answer","busy","canceled"]}}}},{"type":"object","description":"Save the call to Omni CRM."}]},"cloud_whatsapp":{"allOf":[{"type":"object","description":"Settings every post-call channel shares.","properties":{"enabled":{"type":"boolean"},"include":{"type":"array","description":"Which sections to include in this action.","items":{"type":"string","enum":["summary","extracted_variables","fullConversation","sentiment"]}},"extracted_variables":{"type":"array","description":"Variables the model should pull out of the conversation for this action.","items":{"type":"object","required":["key","prompt"],"properties":{"key":{"type":"string","description":"Unique identifier for the variable in the post-call payload.","example":"customer_issue"},"prompt":{"type":"string","description":"Instruction for the model on what to pull out of the conversation.","example":"Identify the main issue the customer is experiencing."}}}},"trigger_call_statuses":{"type":"array","description":"Call outcomes that fire this action. Omit to use the default\n(`completed`, `voicemail_detected`).\n","items":{"type":"string","enum":["completed","voicemail_detected","failed","no-answer","busy","canceled"]}}}},{"type":"object","description":"Send a Cloud WhatsApp template message after the call.","properties":{"phone_number_id":{"type":"integer","description":"The id of your organization's Cloud WhatsApp number the\nmessage is sent from.\n"},"template_id":{"type":"integer","description":"An approved template on that number. A template that is not\napproved, or that belongs to another number, is refused.\n"},"template_variables":{"type":"array","description":"Which extracted variable fills each template placeholder.","items":{"type":"object","properties":{"index":{"type":"string","description":"The placeholder number, as a string.","example":"1"},"extracted_var":{"type":"string","description":"The key of the extracted variable whose value fills this placeholder.","example":"customer_name"}}}},"templates":{"type":"array","description":"One or more templates to send, each with its variable mapping.","items":{"type":"object","description":"One Cloud WhatsApp template to send after the call.","properties":{"template_id":{"type":"integer","description":"An approved template on the chosen number."},"usage_description":{"type":"string","description":"When this template should be sent. After the call, the model reads\nthese descriptions to choose which templates fit the conversation.\n","example":"Send when the caller books an appointment."},"always_send":{"type":"boolean","description":"Send this template after every call, whichever templates the model chooses."},"variable_mappings":{"type":"array","description":"How to fill each template placeholder.","items":{"type":"object","properties":{"index":{"type":"string","description":"The placeholder number, as a string.","example":"1"},"extracted_var":{"type":"string","description":"The extracted variable whose value fills this placeholder."},"static_value":{"type":"string","description":"A fixed value for this placeholder. When set, it is used\ninstead of the extracted variable.\n"},"mode":{"type":"string","enum":["variable","static"],"description":"Which input the dashboard shows for this placeholder. It\ndoes not change the value sent: a `static_value` is used\nfirst, then the extracted variable, then `fallback_value`.\n"},"fallback_value":{"type":"string","description":"The value to use when the variable is not extracted."}}}}}}}}}]},"workflow":{"allOf":[{"type":"object","description":"Settings every post-call channel shares.","properties":{"enabled":{"type":"boolean"},"include":{"type":"array","description":"Which sections to include in this action.","items":{"type":"string","enum":["summary","extracted_variables","fullConversation","sentiment"]}},"extracted_variables":{"type":"array","description":"Variables the model should pull out of the conversation for this action.","items":{"type":"object","required":["key","prompt"],"properties":{"key":{"type":"string","description":"Unique identifier for the variable in the post-call payload.","example":"customer_issue"},"prompt":{"type":"string","description":"Instruction for the model on what to pull out of the conversation.","example":"Identify the main issue the customer is experiencing."}}}},"trigger_call_statuses":{"type":"array","description":"Call outcomes that fire this action. Omit to use the default\n(`completed`, `voicemail_detected`).\n","items":{"type":"string","enum":["completed","voicemail_detected","failed","no-answer","busy","canceled"]}}}},{"type":"object","description":"Trigger a workflow after the call.","properties":{"workflow_id":{"type":"integer","description":"The id of the workflow to run."}}}]},"google_sheets":{"allOf":[{"type":"object","description":"Settings every post-call channel shares.","properties":{"enabled":{"type":"boolean"},"include":{"type":"array","description":"Which sections to include in this action.","items":{"type":"string","enum":["summary","extracted_variables","fullConversation","sentiment"]}},"extracted_variables":{"type":"array","description":"Variables the model should pull out of the conversation for this action.","items":{"type":"object","required":["key","prompt"],"properties":{"key":{"type":"string","description":"Unique identifier for the variable in the post-call payload.","example":"customer_issue"},"prompt":{"type":"string","description":"Instruction for the model on what to pull out of the conversation.","example":"Identify the main issue the customer is experiencing."}}}},"trigger_call_statuses":{"type":"array","description":"Call outcomes that fire this action. Omit to use the default\n(`completed`, `voicemail_detected`).\n","items":{"type":"string","enum":["completed","voicemail_detected","failed","no-answer","busy","canceled"]}}}},{"type":"object","description":"Append the call to a Google Sheet. Sending this key replaces the\nagent's Google Sheets actions; leaving it out keeps them.\n","properties":{"integration_id":{"type":"integer","description":"Required. The id of your Google Sheets integration."},"spreadsheet_id":{"type":"string","description":"Required. The id in the sheet's URL, the part after `/d/`."},"spreadsheet_name":{"type":"string"},"worksheet_name":{"type":"string","description":"The tab to append to. Defaults to `Sheet1`."}}}]},"slack":{"allOf":[{"type":"object","description":"Settings every post-call channel shares.","properties":{"enabled":{"type":"boolean"},"include":{"type":"array","description":"Which sections to include in this action.","items":{"type":"string","enum":["summary","extracted_variables","fullConversation","sentiment"]}},"extracted_variables":{"type":"array","description":"Variables the model should pull out of the conversation for this action.","items":{"type":"object","required":["key","prompt"],"properties":{"key":{"type":"string","description":"Unique identifier for the variable in the post-call payload.","example":"customer_issue"},"prompt":{"type":"string","description":"Instruction for the model on what to pull out of the conversation.","example":"Identify the main issue the customer is experiencing."}}}},"trigger_call_statuses":{"type":"array","description":"Call outcomes that fire this action. Omit to use the default\n(`completed`, `voicemail_detected`).\n","items":{"type":"string","enum":["completed","voicemail_detected","failed","no-answer","busy","canceled"]}}}},{"type":"object","description":"Post the call to a Slack channel. Sending this key replaces the\nagent's Slack actions; leaving it out keeps them.\n","properties":{"integration_id":{"type":"integer","description":"Required. The id of your Slack integration."},"channel_id":{"type":"string","description":"The channel id. Send this or `channel_name`."},"channel_name":{"type":"string","description":"The channel name. Send this or `channel_id`."}}}]},"salesforce":{"allOf":[{"type":"object","description":"Settings every post-call channel shares.","properties":{"enabled":{"type":"boolean"},"include":{"type":"array","description":"Which sections to include in this action.","items":{"type":"string","enum":["summary","extracted_variables","fullConversation","sentiment"]}},"extracted_variables":{"type":"array","description":"Variables the model should pull out of the conversation for this action.","items":{"type":"object","required":["key","prompt"],"properties":{"key":{"type":"string","description":"Unique identifier for the variable in the post-call payload.","example":"customer_issue"},"prompt":{"type":"string","description":"Instruction for the model on what to pull out of the conversation.","example":"Identify the main issue the customer is experiencing."}}}},"trigger_call_statuses":{"type":"array","description":"Call outcomes that fire this action. Omit to use the default\n(`completed`, `voicemail_detected`).\n","items":{"type":"string","enum":["completed","voicemail_detected","failed","no-answer","busy","canceled"]}}}},{"type":"object","description":"Create a Salesforce record from the call. Sends a fixed set of\nfields for the object, so it takes no `extracted_variables`.\nSending this key replaces the agent's Salesforce actions;\nleaving it out keeps them.\n","properties":{"integration_id":{"type":"integer","description":"Required. The id of your Salesforce integration."},"object_name":{"type":"string","enum":["Lead","Contact","Account","Opportunity","Case","Task","Product"],"description":"Defaults to `Lead`."}}}]},"hubspot":{"allOf":[{"type":"object","description":"Settings every post-call channel shares.","properties":{"enabled":{"type":"boolean"},"include":{"type":"array","description":"Which sections to include in this action.","items":{"type":"string","enum":["summary","extracted_variables","fullConversation","sentiment"]}},"extracted_variables":{"type":"array","description":"Variables the model should pull out of the conversation for this action.","items":{"type":"object","required":["key","prompt"],"properties":{"key":{"type":"string","description":"Unique identifier for the variable in the post-call payload.","example":"customer_issue"},"prompt":{"type":"string","description":"Instruction for the model on what to pull out of the conversation.","example":"Identify the main issue the customer is experiencing."}}}},"trigger_call_statuses":{"type":"array","description":"Call outcomes that fire this action. Omit to use the default\n(`completed`, `voicemail_detected`).\n","items":{"type":"string","enum":["completed","voicemail_detected","failed","no-answer","busy","canceled"]}}}},{"type":"object","description":"Create a HubSpot record from the call. Sends a fixed set of\nfields for the object, so it takes no `extracted_variables`.\nSending this key replaces the agent's HubSpot actions; leaving\nit out keeps them.\n","properties":{"integration_id":{"type":"integer","description":"Required. The id of your HubSpot integration."},"object_name":{"type":"string","enum":["contact","company","deal","ticket"],"description":"Required."}}}]},"zoho_bigin":{"allOf":[{"type":"object","description":"Settings every post-call channel shares.","properties":{"enabled":{"type":"boolean"},"include":{"type":"array","description":"Which sections to include in this action.","items":{"type":"string","enum":["summary","extracted_variables","fullConversation","sentiment"]}},"extracted_variables":{"type":"array","description":"Variables the model should pull out of the conversation for this action.","items":{"type":"object","required":["key","prompt"],"properties":{"key":{"type":"string","description":"Unique identifier for the variable in the post-call payload.","example":"customer_issue"},"prompt":{"type":"string","description":"Instruction for the model on what to pull out of the conversation.","example":"Identify the main issue the customer is experiencing."}}}},"trigger_call_statuses":{"type":"array","description":"Call outcomes that fire this action. Omit to use the default\n(`completed`, `voicemail_detected`).\n","items":{"type":"string","enum":["completed","voicemail_detected","failed","no-answer","busy","canceled"]}}}},{"type":"object","description":"Log the call in Zoho Bigin. Sending this key replaces the\nagent's Zoho Bigin actions; leaving it out keeps them.\n","properties":{"integration_id":{"type":"integer","description":"Required. The id of your Zoho Bigin integration."},"create_call_log":{"type":"boolean","description":"Log the call. Defaults to true."},"update_contact":{"type":"boolean","description":"Update a matching contact with what the call captured. Defaults to true."},"create_contact":{"type":"boolean","description":"Create a contact when no contact matches. Defaults to true."}}}]}}},"transfer":{"type":"object","description":"Conditional call transfer to a human agent or another number.","properties":{"enabled":{"type":"boolean"},"transfer_options":{"type":"array","description":"Where to transfer the call and under what condition. The first matching condition wins. In an agent update, sending this list replaces all saved options. Omit it to keep them unchanged, or send an empty array to clear them.","items":{"type":"object","required":["number","transfer_condition","transfer_message"],"properties":{"number":{"type":"string","description":"Primary phone number to transfer to. Include country code with leading `+`."},"type":{"type":"string","enum":["static","dynamic"],"default":"static","description":"`static` transfers to `number`. `dynamic` lets the agent\npick a number at runtime based on the conversation.\n"},"backup_numbers":{"type":"array","description":"Fallback numbers tried if the primary is unreachable.","items":{"type":"string"}},"transfer_condition":{"type":"string","description":"Natural-language condition that triggers this transfer option."},"transfer_message":{"type":"string","description":"Message the agent says to the caller before executing the transfer."}}}}}},"end_call":{"type":"object","description":"Hang up automatically when a condition is met.","properties":{"enabled":{"type":"boolean"},"condition":{"type":"string","description":"Natural-language condition that triggers ending the call. Only evaluated when `enabled` is true."},"message":{"type":"string","description":"What the agent says before hanging up."},"message_type":{"type":"string","enum":["static","prompt"],"description":"`static` speaks `message` verbatim. `prompt` treats\n`message_prompt` as an LLM instruction and generates a\nfresh closing line each call (useful for matching the\ncaller's language and tone).\n"},"message_prompt":{"type":"string","description":"LLM prompt used to generate the closing line when `message_type` is `prompt`."}}},"background_track":{"type":"object","description":"Ambient background noise that plays under the agent's voice.","properties":{"enabled":{"type":"boolean","description":"Whether to mix the ambient track under the agent's audio."},"name":{"type":"string","enum":["call_center","filler","office","office_1","restaurant"],"description":"Ambient track to mix under the agent."},"volume":{"type":"number","minimum":0,"maximum":1,"default":0.2,"description":"Volume level on a 0–1 scale. Default 0.2."},"tts_volume_reduction":{"type":"number","minimum":0,"maximum":1,"description":"Amount to drop the agent's TTS volume while the ambient track plays, on a 0–1 scale. Helps the voice cut through without raising the overall mix."}}},"initial_ringing_sound_enabled":{"type":"boolean","description":"Plays a ringing tone after the call is picked up, until the agent starts speaking."},"voicemail":{"type":"object","description":"Voicemail / answering-machine handling for outbound calls. Set this with the nested object shown here; the agent object returns these values as the flat fields `voicemail_enabled` and `voicemail_message`. Voicemail detection is an access-gated feature. If it isn't enabled for your account, [request access](https://omnidim.io/contact-us?reason=product&lock=1).","properties":{"enabled":{"type":"boolean","description":"Detect voicemail and leave your message instead of speaking to a machine."},"message":{"type":"string","description":"Message to leave when voicemail is detected."}}},"languages":{"type":"array","description":"Languages the agent should support. Pass each language as a display-name string exactly as it appears in the dashboard's language picker. Unrecognized names are skipped.","items":{"type":"string"}}}}},"required":["agent_id","requestBody"]},
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
  ["listPostCallActions", {
    name: "listPostCallActions",
    description: `List every post-call action on the agent, each with its own \`id\`.
(Tags: Agents)`,
    inputSchema: {"type":"object","properties":{"agent_id":{"type":"number","description":"The ID of the agent."}},"required":["agent_id"]},
    method: "get",
    pathTemplate: "/agents/{agent_id}/post-call-actions",
    executionParameters: [{"name":"agent_id","in":"path"}],
    requestBodyContentType: undefined,
    securityRequirements: [{"BearerAuth":[]}],
    tags: ["Agents"],
    deprecated: false
  }],
  ["addPostCallAction", {
    name: "addPostCallAction",
    description: `Add one post-call action to the agent. The agent's other actions are not changed. Send an \`Idempotency-Key\` header to make a retry safe: the same key and body return the action the first request added.
(Tags: Agents)`,
    inputSchema: {"type":"object","properties":{"agent_id":{"type":"number","description":"The ID of the agent."},"Idempotency-Key":{"type":"string","description":"Any unique string. A retry with the same key and body adds nothing new."},"requestBody":{"allOf":[{"type":"object","description":"One post-call action. `type` picks the channel; send the fields of\nthat channel plus any of the shared ones. `type` is required when\nadding an action; an update sends only the fields it changes.\n","properties":{"type":{"type":"string","enum":["email","webhook","omni_crm","cloud_whatsapp","workflow","google_sheets","slack","salesforce","hubspot","zoho_bigin"],"description":"The channel. It cannot change after the action is created:\ndelete it and add a new one. `google_sheets`, `slack`,\n`salesforce`, `hubspot` and `zoho_bigin` deliver through an\naccount connected in the dashboard: pass its id as\n`integration_id` (see List integrations).\n"},"integration_id":{"type":"integer","description":"`google_sheets`, `slack`, `salesforce`, `hubspot`, `zoho_bigin`\nonly, required: the id of your integration of that type.\n"},"spreadsheet_id":{"type":"string","description":"`google_sheets` only, required: the id in the sheet's URL, the\npart after `/d/`.\n","example":"1BxiMVs0XRA5nFMdKvBdBZjgmUUqptlbs74OgvE2upms"},"spreadsheet_name":{"type":"string","description":"`google_sheets` only: the sheet's name, for display."},"worksheet_name":{"type":"string","description":"`google_sheets` only: the tab to append to. Defaults to `Sheet1`.","example":"Calls"},"channel_id":{"type":"string","description":"`slack` only: the channel id. Send this or `channel_name`.","example":"C08RTQ1NY81"},"channel_name":{"type":"string","description":"`slack` only: the channel name. Send this or `channel_id`.","example":"sales"},"object_name":{"type":"string","description":"`salesforce`: `Lead` (default), `Contact`, `Account`,\n`Opportunity`, `Case`, `Task` or `Product`. `hubspot`, required:\n`contact`, `company`, `deal` or `ticket`. Both send a fixed set of\nfields for the chosen object, so they take no `extracted_variables`.\n"},"create_call_log":{"type":"boolean","description":"`zoho_bigin` only: log the call in Zoho Bigin. Defaults to true."},"update_contact":{"type":"boolean","description":"`zoho_bigin` only: update a matching contact with what the call captured. Defaults to true."},"create_contact":{"type":"boolean","description":"`zoho_bigin` only: create a contact when no contact matches. Defaults to true."},"recipients":{"type":"array","description":"`email` only, required: the addresses to notify.","items":{"type":"string","format":"email"},"example":["support@acme-corp.io"]},"url":{"type":"string","format":"uri","description":"`webhook` only, required: the endpoint that receives a POST with the call payload.","example":"https://crm.acme-corp.io/omnidim-callback"},"phone_number_id":{"type":"integer","description":"`cloud_whatsapp` only, required: your Cloud WhatsApp number the message is sent from. Also send `template_id` or `templates`, or nothing is sent."},"template_id":{"type":"integer","description":"`cloud_whatsapp` only: an approved template on that number."},"template_variables":{"type":"array","description":"`cloud_whatsapp` only: which extracted variable fills each template placeholder.","items":{"type":"object","properties":{"index":{"type":"string","description":"The placeholder number, as a string.","example":"1"},"extracted_var":{"type":"string","description":"The key of the extracted variable whose value fills this placeholder.","example":"customer_name"}}}},"templates":{"type":"array","description":"`cloud_whatsapp` only: one or more templates to send.","items":{"type":"object","description":"One Cloud WhatsApp template to send after the call.","properties":{"template_id":{"type":"integer","description":"An approved template on the chosen number."},"usage_description":{"type":"string","description":"When this template should be sent. After the call, the model reads\nthese descriptions to choose which templates fit the conversation.\n","example":"Send when the caller books an appointment."},"always_send":{"type":"boolean","description":"Send this template after every call, whichever templates the model chooses."},"variable_mappings":{"type":"array","description":"How to fill each template placeholder.","items":{"type":"object","properties":{"index":{"type":"string","description":"The placeholder number, as a string.","example":"1"},"extracted_var":{"type":"string","description":"The extracted variable whose value fills this placeholder."},"static_value":{"type":"string","description":"A fixed value for this placeholder. When set, it is used\ninstead of the extracted variable.\n"},"mode":{"type":"string","enum":["variable","static"],"description":"Which input the dashboard shows for this placeholder. It\ndoes not change the value sent: a `static_value` is used\nfirst, then the extracted variable, then `fallback_value`.\n"},"fallback_value":{"type":"string","description":"The value to use when the variable is not extracted."}}}}}}},"workflow_id":{"type":"integer","description":"`workflow` only, required: the workflow to run. It must have a published version, or the action is skipped."},"include":{"type":"array","description":"Which sections to include.","items":{"type":"string","enum":["summary","extracted_variables","fullConversation","sentiment"]}},"extracted_variables":{"type":"array","description":"Variables the model should pull out of the conversation. A key\nalready used by another action on this agent must have the same\nprompt, or the request is refused with `400`. Other actions are\nnever changed to match.\n","items":{"type":"object","required":["key","prompt"],"properties":{"key":{"type":"string","description":"Unique identifier for the variable in the post-call payload.","example":"customer_issue"},"prompt":{"type":"string","description":"Instruction for the model on what to pull out of the conversation.","example":"Identify the main issue the customer is experiencing."}}}},"trigger_call_statuses":{"type":"array","description":"Call outcomes that fire this action. Omit to use the default\n(`completed`, `voicemail_detected`).\n","items":{"type":"string","enum":["completed","voicemail_detected","failed","no-answer","busy","canceled"]}}}},{"required":["type"]}],"description":"The JSON request body."}},"required":["agent_id","requestBody"]},
    method: "post",
    pathTemplate: "/agents/{agent_id}/post-call-actions",
    executionParameters: [{"name":"agent_id","in":"path"},{"name":"Idempotency-Key","in":"header"}],
    requestBodyContentType: "application/json",
    securityRequirements: [{"BearerAuth":[]}],
    tags: ["Agents"],
    deprecated: false
  }],
  ["deletePostCallAction", {
    name: "deletePostCallAction",
    description: `Remove one post-call action from the agent. The agent's other actions are not changed.
(Tags: Agents)`,
    inputSchema: {"type":"object","properties":{"agent_id":{"type":"number","description":"The ID of the agent."},"action_id":{"type":"number","description":"The ID of the post-call action."}},"required":["agent_id","action_id"]},
    method: "delete",
    pathTemplate: "/agents/{agent_id}/post-call-actions/{action_id}",
    executionParameters: [{"name":"agent_id","in":"path"},{"name":"action_id","in":"path"}],
    requestBodyContentType: undefined,
    securityRequirements: [{"BearerAuth":[]}],
    tags: ["Agents"],
    deprecated: false
  }],
  ["updatePostCallAction", {
    name: "updatePostCallAction",
    description: `Change fields of one post-call action. Fields you don't send keep their value. The \`type\` cannot change.
(Tags: Agents)`,
    inputSchema: {"type":"object","properties":{"agent_id":{"type":"number","description":"The ID of the agent."},"action_id":{"type":"number","description":"The ID of the post-call action."},"requestBody":{"type":"object","description":"One post-call action. `type` picks the channel; send the fields of\nthat channel plus any of the shared ones. `type` is required when\nadding an action; an update sends only the fields it changes.\n","properties":{"type":{"type":"string","enum":["email","webhook","omni_crm","cloud_whatsapp","workflow","google_sheets","slack","salesforce","hubspot","zoho_bigin"],"description":"The channel. It cannot change after the action is created:\ndelete it and add a new one. `google_sheets`, `slack`,\n`salesforce`, `hubspot` and `zoho_bigin` deliver through an\naccount connected in the dashboard: pass its id as\n`integration_id` (see List integrations).\n"},"integration_id":{"type":"number","description":"`google_sheets`, `slack`, `salesforce`, `hubspot`, `zoho_bigin`\nonly, required: the id of your integration of that type.\n"},"spreadsheet_id":{"type":"string","description":"`google_sheets` only, required: the id in the sheet's URL, the\npart after `/d/`.\n"},"spreadsheet_name":{"type":"string","description":"`google_sheets` only: the sheet's name, for display."},"worksheet_name":{"type":"string","description":"`google_sheets` only: the tab to append to. Defaults to `Sheet1`."},"channel_id":{"type":"string","description":"`slack` only: the channel id. Send this or `channel_name`."},"channel_name":{"type":"string","description":"`slack` only: the channel name. Send this or `channel_id`."},"object_name":{"type":"string","description":"`salesforce`: `Lead` (default), `Contact`, `Account`,\n`Opportunity`, `Case`, `Task` or `Product`. `hubspot`, required:\n`contact`, `company`, `deal` or `ticket`. Both send a fixed set of\nfields for the chosen object, so they take no `extracted_variables`.\n"},"create_call_log":{"type":"boolean","description":"`zoho_bigin` only: log the call in Zoho Bigin. Defaults to true."},"update_contact":{"type":"boolean","description":"`zoho_bigin` only: update a matching contact with what the call captured. Defaults to true."},"create_contact":{"type":"boolean","description":"`zoho_bigin` only: create a contact when no contact matches. Defaults to true."},"recipients":{"type":"array","description":"`email` only, required: the addresses to notify.","items":{"type":"string","format":"email"}},"url":{"type":"string","format":"uri","description":"`webhook` only, required: the endpoint that receives a POST with the call payload."},"phone_number_id":{"type":"number","description":"`cloud_whatsapp` only, required: your Cloud WhatsApp number the message is sent from. Also send `template_id` or `templates`, or nothing is sent."},"template_id":{"type":"number","description":"`cloud_whatsapp` only: an approved template on that number."},"template_variables":{"type":"array","description":"`cloud_whatsapp` only: which extracted variable fills each template placeholder.","items":{"type":"object","properties":{"index":{"type":"string","description":"The placeholder number, as a string."},"extracted_var":{"type":"string","description":"The key of the extracted variable whose value fills this placeholder."}}}},"templates":{"type":"array","description":"`cloud_whatsapp` only: one or more templates to send.","items":{"type":"object","description":"One Cloud WhatsApp template to send after the call.","properties":{"template_id":{"type":"number","description":"An approved template on the chosen number."},"usage_description":{"type":"string","description":"When this template should be sent. After the call, the model reads\nthese descriptions to choose which templates fit the conversation.\n"},"always_send":{"type":"boolean","description":"Send this template after every call, whichever templates the model chooses."},"variable_mappings":{"type":"array","description":"How to fill each template placeholder.","items":{"type":"object","properties":{"index":{"type":"string","description":"The placeholder number, as a string."},"extracted_var":{"type":"string","description":"The extracted variable whose value fills this placeholder."},"static_value":{"type":"string","description":"A fixed value for this placeholder. When set, it is used\ninstead of the extracted variable.\n"},"mode":{"type":"string","enum":["variable","static"],"description":"Which input the dashboard shows for this placeholder. It\ndoes not change the value sent: a `static_value` is used\nfirst, then the extracted variable, then `fallback_value`.\n"},"fallback_value":{"type":"string","description":"The value to use when the variable is not extracted."}}}}}}},"workflow_id":{"type":"number","description":"`workflow` only, required: the workflow to run. It must have a published version, or the action is skipped."},"include":{"type":"array","description":"Which sections to include.","items":{"type":"string","enum":["summary","extracted_variables","fullConversation","sentiment"]}},"extracted_variables":{"type":"array","description":"Variables the model should pull out of the conversation. A key\nalready used by another action on this agent must have the same\nprompt, or the request is refused with `400`. Other actions are\nnever changed to match.\n","items":{"type":"object","required":["key","prompt"],"properties":{"key":{"type":"string","description":"Unique identifier for the variable in the post-call payload."},"prompt":{"type":"string","description":"Instruction for the model on what to pull out of the conversation."}}}},"trigger_call_statuses":{"type":"array","description":"Call outcomes that fire this action. Omit to use the default\n(`completed`, `voicemail_detected`).\n","items":{"type":"string","enum":["completed","voicemail_detected","failed","no-answer","busy","canceled"]}}}}},"required":["agent_id","action_id","requestBody"]},
    method: "patch",
    pathTemplate: "/agents/{agent_id}/post-call-actions/{action_id}",
    executionParameters: [{"name":"agent_id","in":"path"},{"name":"action_id","in":"path"}],
    requestBodyContentType: "application/json",
    securityRequirements: [{"BearerAuth":[]}],
    tags: ["Agents"],
    deprecated: false
  }],
  ["listIntegrations", {
    name: "listIntegrations",
    description: `List the integrations connected to your workspace, with each one's \`id\` and \`integration_type\`. Stored credentials (tokens, secrets, passwords, API keys, and the values of a custom API's headers and parameters) are never returned: they read \`********\`. When you create an integration, send the real values: \`********\` is refused. Accounts that sign in with OAuth (Google Sheets, Slack, HubSpot, Salesforce, Zoho Bigin) are connected in the dashboard.
(Tags: Integrations)`,
    inputSchema: {"type":"object","properties":{}},
    method: "get",
    pathTemplate: "/integrations",
    executionParameters: [],
    requestBodyContentType: undefined,
    securityRequirements: [{"BearerAuth":[]}],
    tags: ["Integrations"],
    deprecated: false
  }],
  ["createCustomApiIntegration", {
    name: "createCustomApiIntegration",
    description: `Save a call to your own HTTP endpoint as an integration. Attach it to an agent with \`attachAgentIntegration\`, and the agent calls the endpoint during a call when the conversation needs it, then uses the response in its reply. Parameters marked \`isLLMGenerated\` are filled in by the agent from the conversation.
(Tags: Integrations)`,
    inputSchema: {"type":"object","properties":{"requestBody":{"type":"object","required":["name","url","method"],"properties":{"name":{"type":"string","description":"A name for the integration."},"description":{"type":"string","description":"What the endpoint does. The agent reads this to decide\nwhen to call it, so say what it returns and when it is useful.\n"},"url":{"type":"string","format":"uri"},"method":{"type":"string","enum":["GET","POST","PUT","PATCH","DELETE"]},"headers":{"type":"array","description":"Fixed headers sent on every request.","items":{"type":"object","required":["key","value"],"properties":{"key":{"type":"string"},"value":{"type":"string"}}}},"query_params":{"type":"array","description":"Query string parameters.","items":{"type":"object","description":"One query or body parameter of a custom API. With `isLLMGenerated`\ntrue the agent fills the value from the conversation, guided by\n`description`. With it false, the text in `description` is sent as a\nfixed value.\n","required":["key"],"properties":{"key":{"type":"string","description":"The parameter name your endpoint expects."},"description":{"type":"string","description":"What the agent should put here, or the fixed value when `isLLMGenerated` is false."},"type":{"type":"string","enum":["string","number","boolean","object","array"],"default":"string"},"required":{"type":"boolean","description":"Whether the agent must supply this parameter."},"isLLMGenerated":{"type":"boolean","default":true,"description":"Let the agent fill this value from the conversation."},"children":{"type":"array","description":"Nested fields of an `object` or `array` body parameter. Query parameters have no children.","items":{"type":"object"}}}}},"body_params":{"type":"array","description":"Request body fields, sent as JSON. A GET request sends no\nbody. Every request with a body also carries the call's\n`from_number`, `to_number` and `call_sid`.\n","items":{"type":"object","description":"One query or body parameter of a custom API. With `isLLMGenerated`\ntrue the agent fills the value from the conversation, guided by\n`description`. With it false, the text in `description` is sent as a\nfixed value.\n","required":["key"],"properties":{"key":{"type":"string","description":"The parameter name your endpoint expects."},"description":{"type":"string","description":"What the agent should put here, or the fixed value when `isLLMGenerated` is false."},"type":{"type":"string","enum":["string","number","boolean","object","array"],"default":"string"},"required":{"type":"boolean","description":"Whether the agent must supply this parameter."},"isLLMGenerated":{"type":"boolean","default":true,"description":"Let the agent fill this value from the conversation."},"children":{"type":"array","description":"Nested fields of an `object` or `array` body parameter. Query parameters have no children.","items":{"type":"object"}}}}},"request_timeout":{"type":"number","default":10,"description":"Seconds to wait for your endpoint before the agent moves on."}},"description":"The JSON request body."}},"required":["requestBody"]},
    method: "post",
    pathTemplate: "/integrations/custom-api",
    executionParameters: [],
    requestBodyContentType: "application/json",
    securityRequirements: [{"BearerAuth":[]}],
    tags: ["Integrations"],
    deprecated: false
  }],
  ["createCalIntegration", {
    name: "createCalIntegration",
    description: `Connect a Cal.com event type so an agent can check availability and book meetings during a call. Attach it to an agent with \`attachAgentIntegration\`.
(Tags: Integrations)`,
    inputSchema: {"type":"object","properties":{"requestBody":{"type":"object","required":["name","cal_api_key","cal_id","cal_timezone"],"properties":{"name":{"type":"string","description":"A name for the integration."},"cal_api_key":{"type":"string","description":"Your Cal.com API key."},"cal_id":{"type":"string","description":"The Cal.com event type id to book."},"cal_timezone":{"type":"string","description":"IANA time zone for the bookings, such as `America/New_York`."}},"description":"The JSON request body."}},"required":["requestBody"]},
    method: "post",
    pathTemplate: "/integrations/cal",
    executionParameters: [],
    requestBodyContentType: "application/json",
    securityRequirements: [{"BearerAuth":[]}],
    tags: ["Integrations"],
    deprecated: false
  }],
  ["listAgentIntegrations", {
    name: "listAgentIntegrations",
    description: `List the integrations attached to the agent. Stored credentials read \`********\`.
(Tags: Integrations)`,
    inputSchema: {"type":"object","properties":{"agent_id":{"type":"number","description":"The ID of the agent."}},"required":["agent_id"]},
    method: "get",
    pathTemplate: "/agents/{agent_id}/integrations",
    executionParameters: [{"name":"agent_id","in":"path"}],
    requestBodyContentType: undefined,
    securityRequirements: [{"BearerAuth":[]}],
    tags: ["Integrations"],
    deprecated: false
  }],
  ["attachAgentIntegration", {
    name: "attachAgentIntegration",
    description: `Attach one of your integrations to the agent. The agent can use it on its next call. Integrations already attached stay as they are.
(Tags: Integrations)`,
    inputSchema: {"type":"object","properties":{"agent_id":{"type":"number","description":"The ID of the agent."},"requestBody":{"type":"object","required":["integration_id"],"properties":{"integration_id":{"type":"number","description":"The integration's id, from `listIntegrations` or a create response."}},"description":"The JSON request body."}},"required":["agent_id","requestBody"]},
    method: "post",
    pathTemplate: "/agents/{agent_id}/integrations",
    executionParameters: [{"name":"agent_id","in":"path"}],
    requestBodyContentType: "application/json",
    securityRequirements: [{"BearerAuth":[]}],
    tags: ["Integrations"],
    deprecated: false
  }],
  ["detachAgentIntegration", {
    name: "detachAgentIntegration",
    description: `Remove the integration from the agent. The integration itself is kept and stays available to attach again.
(Tags: Integrations)`,
    inputSchema: {"type":"object","properties":{"agent_id":{"type":"number","description":"The ID of the agent."},"integration_id":{"type":"number","description":"The ID of the integration to detach."}},"required":["agent_id","integration_id"]},
    method: "delete",
    pathTemplate: "/agents/{agent_id}/integrations/{integration_id}",
    executionParameters: [{"name":"agent_id","in":"path"},{"name":"integration_id","in":"path"}],
    requestBodyContentType: undefined,
    securityRequirements: [{"BearerAuth":[]}],
    tags: ["Integrations"],
    deprecated: false
  }],
  ["listAgentVersions", {
    name: "listAgentVersions",
    description: `List an agent's saved versions, newest first. Includes manual (named) versions, automatic versions, and system backups taken before a restore.
(Tags: Agents)`,
    inputSchema: {"type":"object","properties":{"agent_id":{"type":"number","description":"The ID of the agent."},"pageno":{"type":"integer","minimum":1,"default":1,"description":"Page number for pagination."},"pagesize":{"type":"integer","minimum":1,"default":30,"maximum":150,"description":"Number of items per page (max 150)."},"search":{"type":"string","description":"Filter versions whose name matches this substring (case-insensitive)."},"kind":{"type":"string","enum":["manual","system"],"description":"Filter versions by kind."}},"required":["agent_id"]},
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
    inputSchema: {"type":"object","properties":{"agent_id":{"type":"number","description":"The ID of the agent."},"version_number":{"type":"number","description":"The version number, as returned in `version_number` from the list or save endpoints."},"requestBody":{"type":"object","properties":{},"description":"The JSON request body."}},"required":["agent_id","version_number"]},
    method: "post",
    pathTemplate: "/agents/{agent_id}/versions/{version_number}/restore",
    executionParameters: [{"name":"agent_id","in":"path"},{"name":"version_number","in":"path"}],
    requestBodyContentType: "application/json",
    securityRequirements: [{"BearerAuth":[]}],
    tags: ["Agents"],
    deprecated: false
  }],
  ["dispatchCall", {
    name: "dispatchCall",
    description: `Initiate a call to a phone number using a specified agent. The
phone number must include a country code with a leading plus.

(Tags: Calls)`,
    inputSchema: {"type":"object","properties":{"requestBody":{"type":"object","required":["agent_id","to_number"],"properties":{"agent_id":{"type":"number","description":"The ID of the agent that will handle the call."},"to_number":{"type":"string","description":"The phone number to call. Must include country code (e.g., +15551234567)."},"from_number_id":{"type":"number","description":"Id of a phone number on your account to place the call from (see the phone number list endpoint). Omit to use the platform's default number."},"call_context":{"type":"object","description":"Optional context information as key-value pairs to be passed to the agent during the call. Can contain any custom fields relevant to your use case.","additionalProperties":true},"metadata":{"type":"object","additionalProperties":true,"description":"Key-value pairs stored on the call for your own tracking\n(e.g. CRM or lead IDs). Not shared with the agent; echoed\nback as `metadata` in the post-call webhook so you can\ncorrelate results with your records.\n"},"__languages":{"oneOf":[{"type":"array","items":{"type":"string"}},{"type":"string"}],"description":"Languages this call runs in, replacing the agent's configured\nlist for this call only. The first entry is the language the\ncall opens in. Send an array, or a pipe-separated string such\nas `Hindi|English`. Names the platform does not recognize are\nskipped and listed in `languages_ignored`.\n"},"__post_call_actions":{"allOf":[{"type":"object","description":"Side effects that fire once the call ends: email, webhook, Omni CRM,\nCloud WhatsApp, a workflow, Google Sheets, Slack, Salesforce, HubSpot\nor Zoho Bigin.\n","properties":{"email":{"type":"object","properties":{"enabled":{"type":"boolean"},"recipients":{"type":"array","description":"Email addresses that should receive the notification.","items":{"type":"string","format":"email"},"example":["support@example.com"]},"include":{"type":"array","description":"Which sections to include in the email body.","items":{"type":"string","enum":["summary","extracted_variables","fullConversation","sentiment"]}},"extracted_variables":{"type":"array","description":"Variables the model should pull out of the conversation for the email.","items":{"type":"object","required":["key","prompt"],"properties":{"key":{"type":"string","description":"Unique identifier for the variable in the post-call payload.","example":"customer_issue"},"prompt":{"type":"string","description":"Instruction for the model on what to pull out of the conversation.","example":"Identify the main issue the customer is experiencing."}}}},"trigger_call_statuses":{"type":"array","description":"Call outcomes that should fire this action. Omit to\nuse the default (`completed`, `voicemail_detected`).\nPass an explicit list to also include failed calls,\nno-answers, busy signals, etc.\n","items":{"type":"string","enum":["completed","voicemail_detected","failed","no-answer","busy","canceled"]},"example":["completed","voicemail_detected"]}}},"webhook":{"type":"object","properties":{"enabled":{"type":"boolean"},"url":{"type":"string","format":"uri","description":"Endpoint that receives a POST with the call payload.","example":"https://your-webhook-endpoint.com/omnidim-callback"},"include":{"type":"array","description":"Which sections to include in the webhook body.","items":{"type":"string","enum":["summary","extracted_variables","fullConversation","sentiment"]}},"extracted_variables":{"type":"array","description":"Variables the model should pull out of the conversation for the webhook.","items":{"type":"object","required":["key","prompt"],"properties":{"key":{"type":"string","description":"Unique identifier for the variable in the post-call payload.","example":"customer_issue"},"prompt":{"type":"string","description":"Instruction for the model on what to pull out of the conversation.","example":"Identify the main issue the customer is experiencing."}}}},"trigger_call_statuses":{"type":"array","description":"Call outcomes that should fire this webhook. Omit to\nuse the default (`completed`, `voicemail_detected`).\n","items":{"type":"string","enum":["completed","voicemail_detected","failed","no-answer","busy","canceled"]},"example":["completed","failed"]}}},"omni_crm":{"allOf":[{"type":"object","description":"Settings every post-call channel shares.","properties":{"enabled":{"type":"boolean"},"include":{"type":"array","description":"Which sections to include in this action.","items":{"type":"string","enum":["summary","extracted_variables","fullConversation","sentiment"]}},"extracted_variables":{"type":"array","description":"Variables the model should pull out of the conversation for this action.","items":{"type":"object","required":["key","prompt"],"properties":{"key":{"type":"string","description":"Unique identifier for the variable in the post-call payload.","example":"customer_issue"},"prompt":{"type":"string","description":"Instruction for the model on what to pull out of the conversation.","example":"Identify the main issue the customer is experiencing."}}}},"trigger_call_statuses":{"type":"array","description":"Call outcomes that fire this action. Omit to use the default\n(`completed`, `voicemail_detected`).\n","items":{"type":"string","enum":["completed","voicemail_detected","failed","no-answer","busy","canceled"]}}}},{"type":"object","description":"Save the call to Omni CRM."}]},"cloud_whatsapp":{"allOf":[{"type":"object","description":"Settings every post-call channel shares.","properties":{"enabled":{"type":"boolean"},"include":{"type":"array","description":"Which sections to include in this action.","items":{"type":"string","enum":["summary","extracted_variables","fullConversation","sentiment"]}},"extracted_variables":{"type":"array","description":"Variables the model should pull out of the conversation for this action.","items":{"type":"object","required":["key","prompt"],"properties":{"key":{"type":"string","description":"Unique identifier for the variable in the post-call payload.","example":"customer_issue"},"prompt":{"type":"string","description":"Instruction for the model on what to pull out of the conversation.","example":"Identify the main issue the customer is experiencing."}}}},"trigger_call_statuses":{"type":"array","description":"Call outcomes that fire this action. Omit to use the default\n(`completed`, `voicemail_detected`).\n","items":{"type":"string","enum":["completed","voicemail_detected","failed","no-answer","busy","canceled"]}}}},{"type":"object","description":"Send a Cloud WhatsApp template message after the call.","properties":{"phone_number_id":{"type":"integer","description":"The id of your organization's Cloud WhatsApp number the\nmessage is sent from.\n"},"template_id":{"type":"integer","description":"An approved template on that number. A template that is not\napproved, or that belongs to another number, is refused.\n"},"template_variables":{"type":"array","description":"Which extracted variable fills each template placeholder.","items":{"type":"object","properties":{"index":{"type":"string","description":"The placeholder number, as a string.","example":"1"},"extracted_var":{"type":"string","description":"The key of the extracted variable whose value fills this placeholder.","example":"customer_name"}}}},"templates":{"type":"array","description":"One or more templates to send, each with its variable mapping.","items":{"type":"object","description":"One Cloud WhatsApp template to send after the call.","properties":{"template_id":{"type":"integer","description":"An approved template on the chosen number."},"usage_description":{"type":"string","description":"When this template should be sent. After the call, the model reads\nthese descriptions to choose which templates fit the conversation.\n","example":"Send when the caller books an appointment."},"always_send":{"type":"boolean","description":"Send this template after every call, whichever templates the model chooses."},"variable_mappings":{"type":"array","description":"How to fill each template placeholder.","items":{"type":"object","properties":{"index":{"type":"string","description":"The placeholder number, as a string.","example":"1"},"extracted_var":{"type":"string","description":"The extracted variable whose value fills this placeholder."},"static_value":{"type":"string","description":"A fixed value for this placeholder. When set, it is used\ninstead of the extracted variable.\n"},"mode":{"type":"string","enum":["variable","static"],"description":"Which input the dashboard shows for this placeholder. It\ndoes not change the value sent: a `static_value` is used\nfirst, then the extracted variable, then `fallback_value`.\n"},"fallback_value":{"type":"string","description":"The value to use when the variable is not extracted."}}}}}}}}}]},"workflow":{"allOf":[{"type":"object","description":"Settings every post-call channel shares.","properties":{"enabled":{"type":"boolean"},"include":{"type":"array","description":"Which sections to include in this action.","items":{"type":"string","enum":["summary","extracted_variables","fullConversation","sentiment"]}},"extracted_variables":{"type":"array","description":"Variables the model should pull out of the conversation for this action.","items":{"type":"object","required":["key","prompt"],"properties":{"key":{"type":"string","description":"Unique identifier for the variable in the post-call payload.","example":"customer_issue"},"prompt":{"type":"string","description":"Instruction for the model on what to pull out of the conversation.","example":"Identify the main issue the customer is experiencing."}}}},"trigger_call_statuses":{"type":"array","description":"Call outcomes that fire this action. Omit to use the default\n(`completed`, `voicemail_detected`).\n","items":{"type":"string","enum":["completed","voicemail_detected","failed","no-answer","busy","canceled"]}}}},{"type":"object","description":"Trigger a workflow after the call.","properties":{"workflow_id":{"type":"integer","description":"The id of the workflow to run."}}}]},"google_sheets":{"allOf":[{"type":"object","description":"Settings every post-call channel shares.","properties":{"enabled":{"type":"boolean"},"include":{"type":"array","description":"Which sections to include in this action.","items":{"type":"string","enum":["summary","extracted_variables","fullConversation","sentiment"]}},"extracted_variables":{"type":"array","description":"Variables the model should pull out of the conversation for this action.","items":{"type":"object","required":["key","prompt"],"properties":{"key":{"type":"string","description":"Unique identifier for the variable in the post-call payload.","example":"customer_issue"},"prompt":{"type":"string","description":"Instruction for the model on what to pull out of the conversation.","example":"Identify the main issue the customer is experiencing."}}}},"trigger_call_statuses":{"type":"array","description":"Call outcomes that fire this action. Omit to use the default\n(`completed`, `voicemail_detected`).\n","items":{"type":"string","enum":["completed","voicemail_detected","failed","no-answer","busy","canceled"]}}}},{"type":"object","description":"Append the call to a Google Sheet. Sending this key replaces the\nagent's Google Sheets actions; leaving it out keeps them.\n","properties":{"integration_id":{"type":"integer","description":"Required. The id of your Google Sheets integration."},"spreadsheet_id":{"type":"string","description":"Required. The id in the sheet's URL, the part after `/d/`."},"spreadsheet_name":{"type":"string"},"worksheet_name":{"type":"string","description":"The tab to append to. Defaults to `Sheet1`."}}}]},"slack":{"allOf":[{"type":"object","description":"Settings every post-call channel shares.","properties":{"enabled":{"type":"boolean"},"include":{"type":"array","description":"Which sections to include in this action.","items":{"type":"string","enum":["summary","extracted_variables","fullConversation","sentiment"]}},"extracted_variables":{"type":"array","description":"Variables the model should pull out of the conversation for this action.","items":{"type":"object","required":["key","prompt"],"properties":{"key":{"type":"string","description":"Unique identifier for the variable in the post-call payload.","example":"customer_issue"},"prompt":{"type":"string","description":"Instruction for the model on what to pull out of the conversation.","example":"Identify the main issue the customer is experiencing."}}}},"trigger_call_statuses":{"type":"array","description":"Call outcomes that fire this action. Omit to use the default\n(`completed`, `voicemail_detected`).\n","items":{"type":"string","enum":["completed","voicemail_detected","failed","no-answer","busy","canceled"]}}}},{"type":"object","description":"Post the call to a Slack channel. Sending this key replaces the\nagent's Slack actions; leaving it out keeps them.\n","properties":{"integration_id":{"type":"integer","description":"Required. The id of your Slack integration."},"channel_id":{"type":"string","description":"The channel id. Send this or `channel_name`."},"channel_name":{"type":"string","description":"The channel name. Send this or `channel_id`."}}}]},"salesforce":{"allOf":[{"type":"object","description":"Settings every post-call channel shares.","properties":{"enabled":{"type":"boolean"},"include":{"type":"array","description":"Which sections to include in this action.","items":{"type":"string","enum":["summary","extracted_variables","fullConversation","sentiment"]}},"extracted_variables":{"type":"array","description":"Variables the model should pull out of the conversation for this action.","items":{"type":"object","required":["key","prompt"],"properties":{"key":{"type":"string","description":"Unique identifier for the variable in the post-call payload.","example":"customer_issue"},"prompt":{"type":"string","description":"Instruction for the model on what to pull out of the conversation.","example":"Identify the main issue the customer is experiencing."}}}},"trigger_call_statuses":{"type":"array","description":"Call outcomes that fire this action. Omit to use the default\n(`completed`, `voicemail_detected`).\n","items":{"type":"string","enum":["completed","voicemail_detected","failed","no-answer","busy","canceled"]}}}},{"type":"object","description":"Create a Salesforce record from the call. Sends a fixed set of\nfields for the object, so it takes no `extracted_variables`.\nSending this key replaces the agent's Salesforce actions;\nleaving it out keeps them.\n","properties":{"integration_id":{"type":"integer","description":"Required. The id of your Salesforce integration."},"object_name":{"type":"string","enum":["Lead","Contact","Account","Opportunity","Case","Task","Product"],"description":"Defaults to `Lead`."}}}]},"hubspot":{"allOf":[{"type":"object","description":"Settings every post-call channel shares.","properties":{"enabled":{"type":"boolean"},"include":{"type":"array","description":"Which sections to include in this action.","items":{"type":"string","enum":["summary","extracted_variables","fullConversation","sentiment"]}},"extracted_variables":{"type":"array","description":"Variables the model should pull out of the conversation for this action.","items":{"type":"object","required":["key","prompt"],"properties":{"key":{"type":"string","description":"Unique identifier for the variable in the post-call payload.","example":"customer_issue"},"prompt":{"type":"string","description":"Instruction for the model on what to pull out of the conversation.","example":"Identify the main issue the customer is experiencing."}}}},"trigger_call_statuses":{"type":"array","description":"Call outcomes that fire this action. Omit to use the default\n(`completed`, `voicemail_detected`).\n","items":{"type":"string","enum":["completed","voicemail_detected","failed","no-answer","busy","canceled"]}}}},{"type":"object","description":"Create a HubSpot record from the call. Sends a fixed set of\nfields for the object, so it takes no `extracted_variables`.\nSending this key replaces the agent's HubSpot actions; leaving\nit out keeps them.\n","properties":{"integration_id":{"type":"integer","description":"Required. The id of your HubSpot integration."},"object_name":{"type":"string","enum":["contact","company","deal","ticket"],"description":"Required."}}}]},"zoho_bigin":{"allOf":[{"type":"object","description":"Settings every post-call channel shares.","properties":{"enabled":{"type":"boolean"},"include":{"type":"array","description":"Which sections to include in this action.","items":{"type":"string","enum":["summary","extracted_variables","fullConversation","sentiment"]}},"extracted_variables":{"type":"array","description":"Variables the model should pull out of the conversation for this action.","items":{"type":"object","required":["key","prompt"],"properties":{"key":{"type":"string","description":"Unique identifier for the variable in the post-call payload.","example":"customer_issue"},"prompt":{"type":"string","description":"Instruction for the model on what to pull out of the conversation.","example":"Identify the main issue the customer is experiencing."}}}},"trigger_call_statuses":{"type":"array","description":"Call outcomes that fire this action. Omit to use the default\n(`completed`, `voicemail_detected`).\n","items":{"type":"string","enum":["completed","voicemail_detected","failed","no-answer","busy","canceled"]}}}},{"type":"object","description":"Log the call in Zoho Bigin. Sending this key replaces the\nagent's Zoho Bigin actions; leaving it out keeps them.\n","properties":{"integration_id":{"type":"integer","description":"Required. The id of your Zoho Bigin integration."},"create_call_log":{"type":"boolean","description":"Log the call. Defaults to true."},"update_contact":{"type":"boolean","description":"Update a matching contact with what the call captured. Defaults to true."},"create_contact":{"type":"boolean","description":"Create a contact when no contact matches. Defaults to true."}}}]}}}],"description":"Post-call actions for this call only, in the same shape as\n`post_call_actions` on agent create. Email and webhook only.\nThey replace the agent's own post-call actions for this call;\nthe agent is not changed. Items that cannot be used are\nskipped and listed in `post_call_actions_ignored`, and the\ncall still goes out. Can also be sent inside `call_context`.\n"}},"description":"The JSON request body."}},"required":["requestBody"]},
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
one behavior on top (drafts, rotation, filtering, scheduling,
retries, dynamic feeding).

The guide below the field reference walks the whole journey: the
first campaign and its response, each behavior with a working
request, every refusal message with its fix, and the endpoints that
operate a campaign once it runs.

(Tags: Bulk calls)`,
    inputSchema: {"type":"object","properties":{"requestBody":{"type":"object","required":["name","phone_number_id"],"properties":{"name":{"type":"string","description":"Name of the bulk call campaign."},"phone_number_id":{"type":"string","description":"The number this campaign calls from. With a `rotation`, the\nrotation numbers dial instead and this one is the standby.\n"},"bot_id":{"type":"number","description":"Agent to run the campaign. Defaults to the agent attached\nto `phone_number_id`; required when the number has none.\n"},"save_as_draft":{"type":"boolean","default":false,"description":"Store the campaign without dialing; start it later with the\nstart endpoint. See Drafts in the guide below.\n"},"call_conditions":{"type":"array","description":"Dial only the contacts that match every condition; the rest\nare kept as `Skipped`. See Filtering in the guide below.\n","items":{"type":"object","required":["column","operator","value"],"properties":{"column":{"type":"string","description":"Key on the contact row to test."},"operator":{"type":"string","default":"equals","enum":["equals","not_equals","contains","greater_than","less_than"],"description":"`contains` is case-insensitive. `greater_than` and\n`less_than` compare numerically, and a row whose value\nis not a number fails the condition rather than\nerroring.\n"},"value":{"type":"string"}}}},"rotation":{"type":"object","description":"Rotate the campaign across several of your numbers, so no\nsingle number burns out. See Rotation in the guide below.\n","required":["numbers"],"properties":{"numbers":{"type":"array","minItems":1,"description":"The numbers to rotate across; each must be yours and\nlisted once.\n","items":{"type":"object","required":["phone_number_id"],"properties":{"phone_number_id":{"type":"number","description":"One of your numbers, from List phone numbers."},"sequence":{"type":"number","default":10,"description":"Rotation order. Lowest dials first."}}}},"strategy":{"type":"string","default":"fixed_count","enum":["fixed_count","cpr_threshold","both","none"],"description":"When to move to the next number: every\n`calls_per_number` calls, on low health score, both, or\nnever.\n"},"calls_per_number":{"type":"number","default":50,"description":"Calls before moving on. Used by `fixed_count` and `both`."},"health_threshold":{"type":"number","default":30,"description":"Health score below which a number is rotated away from.\nUsed by `cpr_threshold` and `both`.\n"},"fallback":{"type":"string","default":"pause","enum":["pause","continue_best"],"description":"When every number is unhealthy: `pause` the campaign,\nor `continue_best` with the healthiest one.\n"}}},"is_dynamic":{"type":"boolean","default":false,"description":"A dynamic campaign stays alive accepting contacts via the\nadd-contact webhooks, and `contact_list` becomes optional.\n"},"contact_list":{"type":"array","description":"Who to call. Each row needs `phone_number`; any other key\nreaches the agent as context for that one call.\n","items":{"type":"object","required":["phone_number"],"properties":{"phone_number":{"type":"string","description":"Phone number in international format (e.g., +15551234567)."}},"additionalProperties":true}},"is_scheduled":{"type":"boolean","default":false,"description":"Whether the campaign should be scheduled for future execution."},"scheduled_datetime":{"type":"string","description":"Scheduled execution time in format `YYYY-MM-DD HH:MM:SS` (required if `is_scheduled` is true)."},"timezone":{"type":"string","default":"UTC","description":"Timezone for scheduled execution."},"concurrent_call_limit":{"type":"number","default":1,"minimum":1,"description":"Maximum number of concurrent calls allowed."},"enabled_reschedule_call":{"type":"boolean","default":false,"description":"Enable automatic call rescheduling. When enabled the system can reschedule unreachable calls."},"retry_config":{"type":"object","description":"Auto-retry configuration object containing retry settings.","properties":{"auto_retry":{"type":"boolean","default":false},"auto_retry_schedule":{"type":"string","enum":["immediately","next_day","scheduled_time"],"description":"When to retry failed calls."},"retry_schedule_days":{"type":"number","default":0,"minimum":0,"description":"Days to wait before a scheduled retry."},"retry_schedule_hours":{"type":"number","default":0,"minimum":0,"description":"Hours to wait before a scheduled retry."},"retry_limit":{"type":"number","default":1,"minimum":1,"maximum":10,"description":"Retry attempts, 1 to 10. To disable retries omit it and\nleave `auto_retry` false; never send `0`. Ignored when\n`retry_steps` is set.\n"},"retry_steps":{"type":"array","minItems":1,"maxItems":10,"description":"A different delay for each retry, in order: retry 1\nwaits for the first step, retry 2 for the second, and\nso on. When set, it replaces `auto_retry_schedule`,\n`retry_schedule_days`, `retry_schedule_hours` and\n`retry_limit`: a contact gets one retry per step. Each\ndelay is at most 30 days. A retry that falls outside\nthe campaign's daily calling hours waits until they\nopen again.\n","items":{"type":"object","required":["delay","unit"],"properties":{"delay":{"type":"number","minimum":0,"description":"How long to wait, in `unit`. `0` retries right away."},"unit":{"type":"string","enum":["minutes","hours","days"]}}}}}}},"description":"The JSON request body."}},"required":["requestBody"]},
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
    description: `Cancel a scheduled bulk-call campaign. A campaign that is already running, or is still a draft, is refused.
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
still added, so a single bad number does not lose the batch. A row that
is missing a column the campaign's \`call_conditions\` need is reported in
\`rejected\`; the condition values themselves are not evaluated on this
route.

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
    inputSchema: {"type":"object","properties":{"bulk_call_id":{"type":"number","description":"Id of the bulk call campaign."},"requestBody":{"type":"object","properties":{},"description":"The JSON request body."}},"required":["bulk_call_id"]},
    method: "post",
    pathTemplate: "/calls/bulk_call/{bulk_call_id}/start",
    executionParameters: [{"name":"bulk_call_id","in":"path"}],
    requestBodyContentType: "application/json",
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
    inputSchema: {"type":"object","properties":{"bulk_call_id":{"type":"number","description":"Id of the bulk call campaign."},"requestBody":{"type":"object","properties":{"retry_strategy":{"type":"string","default":"all","description":"Which contacts to re-queue. `all` takes everything that did\nnot connect. `specific` re-queues only the statuses listed\nin `failure_reasons`.\n"},"failure_reasons":{"type":"array","description":"Statuses to re-queue. Read only when `retry_strategy` is\n`specific`; for example `no-answer` and `busy`. Ignored when\n`retry_strategy` is `all`.\n","items":{"type":"string"}}},"description":"The JSON request body."}},"required":["bulk_call_id"]},
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

A region can have more than one carrier, each stocking different
number series. Pass the \`carrier\` you want; the response names the
carrier its results came from, and that is the carrier a purchase has
to pass.

(Tags: Phone numbers)`,
    inputSchema: {"type":"object","properties":{"region":{"type":"string","enum":["IN","US"],"description":"Region to search in. `IN` and `US` both serve numbers. Which\nregions answer is configuration, so a region with no carrier\nenabled returns `404 not_available` rather than an empty list.\n"},"carrier":{"type":"string","description":"Which carrier's stock to search: carriers in a region do not sell\nthe same numbers. Required where a region has more than one\ncarrier; omitting it there returns `409 carrier_required` naming\nthe region's carriers and what each one stocks.\n"},"pattern":{"type":"string","description":"Digits or prefix to match within the number."},"page":{"type":"number","minimum":1,"default":1,"description":"Page of results to return."},"limit":{"type":"number","minimum":1,"maximum":150,"default":20,"description":"Results per page."}},"required":["region"]},
    method: "get",
    pathTemplate: "/phone_number/search",
    executionParameters: [{"name":"region","in":"query"},{"name":"carrier","in":"query"},{"name":"pattern","in":"query"},{"name":"page","in":"query"},{"name":"limit","in":"query"}],
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
    inputSchema: {"type":"object","properties":{"Idempotency-Key":{"type":"string","description":"Your own unique key for this purchase, for example a\nfresh UUID. Strongly recommended: it is what makes a\nretry safe.\n"},"requestBody":{"type":"object","required":["region","carrier","phone_number"],"properties":{"region":{"type":"string","enum":["IN","US"],"description":"Region the number belongs to."},"phone_number":{"type":"string","description":"The number to buy, as returned by the search operation."},"carrier":{"type":"string","description":"The carrier to buy from: pass the `carrier` the search\nresponse named, so you buy from the inventory you searched.\nRequired where the region has more than one carrier;\nomitting it there returns `409 carrier_required`.\n"}},"description":"The JSON request body."}},"required":["requestBody"]},
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
  ["setPhoneNumberAutoRenew", {
    name: "setPhoneNumberAutoRenew",
    description: `Turn auto-renew off or back on for a number bought from the number shop.
With auto-renew off, the number is not charged again: it keeps working
until the end of the period already paid for and is then released. Turn
it back on before that date and it renews as normal. Sending the value
the number already has changes nothing and still succeeds.

(Tags: Phone numbers)`,
    inputSchema: {"type":"object","properties":{"requestBody":{"type":"object","required":["phone_number","auto_renew"],"properties":{"phone_number":{"type":"string","description":"The number to switch."},"auto_renew":{"type":"boolean","description":"`false` stops renewal, `true` turns it back on. Must be a JSON boolean: a string such as `\"false\"`, a number, or a missing value is refused."}},"description":"The JSON request body."}},"required":["requestBody"]},
    method: "post",
    pathTemplate: "/phone_number/auto_renew",
    executionParameters: [],
    requestBodyContentType: "application/json",
    securityRequirements: [{"BearerAuth":[]}],
    tags: ["Phone numbers"],
    deprecated: false
  }],
  ["attachPhoneNumber", {
    name: "attachPhoneNumber",
    description: `Attach a phone number to an existing agent.
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
    description: `Detach a phone number from its agent.
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
    inputSchema: {"type":"object","properties":{"requestBody":{"type":"object","required":["phone_number","sip_host","sip_trunk_name"],"properties":{"phone_number":{"type":"string","description":"Phone number in E.164 format (starting with `+`)."},"sip_host":{"type":"string","description":"SIP server hostname or IP."},"sip_trunk_name":{"type":"string","description":"Name for this SIP trunk (must be unique within your account)."},"name":{"type":"string","description":"Optional friendly name for the imported number."},"sip_port":{"type":"number","default":5060,"description":"SIP server port."},"sip_username":{"type":"string","description":"SIP authentication username."},"sip_password":{"type":"string","format":"password","description":"SIP authentication password."},"sip_dial_prefix":{"type":"string","description":"Digits added in front of every number dialed through this trunk. See `sip_strip_country_code` for how it combines with the country code."},"sip_strip_country_code":{"type":"boolean","description":"When true, the country code is removed from every number dialed through this trunk. When omitted and `sip_dial_prefix` is set, the country code is removed, so send `false` to keep it."},"sip_strip_plus":{"type":"boolean","description":"When true, strips the leading `+` from the dialed number."}},"description":"The JSON request body."}},"required":["requestBody"]},
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
and Cartesia support advanced filtering by name, language, accent,
and gender.
Other providers support basic pagination only.

(Tags: Providers)`,
    inputSchema: {"type":"object","properties":{"provider":{"type":"string","enum":["eleven_labs","google","deepgram","cartesia","sarvam","rime","playht","hume","inworld","smallest"],"description":"TTS provider to list voices from. Omit to list across all providers."},"search":{"type":"string","description":"Substring match against voice name or description. ElevenLabs and Cartesia."},"language":{"type":"string","description":"ISO language code (e.g. `en`, `hi`, `es`). ElevenLabs and Cartesia."},"accent":{"type":"string","description":"Accent label (e.g. `american`, `british`). ElevenLabs and Cartesia."},"gender":{"type":"string","enum":["male","female"],"description":"Filter voices by gender. ElevenLabs and Cartesia."},"page":{"type":"integer","minimum":1,"default":1,"description":"1-indexed page number."},"page_size":{"type":"integer","minimum":1,"default":30,"maximum":100,"description":"Voices per page. Capped at 100."}}},
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
  ["getAccountBalance", {
    name: "getAccountBalance",
    description: `Read your organization's wallet: the remaining balance, the minutes
it buys at your rates, your plan, your concurrency headroom, and
whether auto-recharge will refill it.

Use it before a campaign, or on a schedule, so you find out you are
low on credit from this endpoint rather than from a call failing
with \`402 payment_required\`.

The response always describes the organization the API key belongs
to. There is no parameter for reading another account; resellers
read a client's figures through the Reseller endpoints.

A balance at or below zero does not always mean calls will stop. An
organization on usage-based billing (\`plan.is_usage_based\`) keeps
placing calls and is metered to its payment method instead, so check
that flag before treating a zero balance as a stop condition.

The API key's user needs Billing access in your organization. If
you get a \`403\`, an administrator can grant it when Billing is
enabled for your organization; when it is not, contact support.

(Tags: Account)`,
    inputSchema: {"type":"object","properties":{}},
    method: "get",
    pathTemplate: "/account/balance",
    executionParameters: [],
    requestBodyContentType: undefined,
    securityRequirements: [{"BearerAuth":[]}],
    tags: ["Account"],
    deprecated: false
  }],
  ["listClonedVoices", {
    name: "listClonedVoices",
    description: `Your cloned voices, oldest first, one cursor page at a time. Call it with
no \`cursor\`, then pass back the \`next_cursor\` you were handed until it is
\`null\`.

Once a voice is \`ready\`, its \`voice_id\` is the provider voice id to put
in an agent's \`voice.voice_id\` with \`voice.provider: cartesia\`.

(Tags: Voice cloning)`,
    inputSchema: {"type":"object","properties":{"limit":{"type":"number","default":20,"maximum":100,"description":"Rows per page. Above 100 the request is refused."},"cursor":{"type":"string","description":"The `next_cursor` from your previous response. Omit it on the first\nrequest. Opaque: pass it back unchanged.\n"}}},
    method: "get",
    pathTemplate: "/voices",
    executionParameters: [{"name":"limit","in":"query"},{"name":"cursor","in":"query"}],
    requestBodyContentType: undefined,
    securityRequirements: [{"BearerAuth":[]}],
    tags: ["Voice cloning"],
    deprecated: false
  }],
  ["createClonedVoice", {
    name: "createClonedVoice",
    description: `Clone a voice from an audio sample. The sample must be Base64 encoded and
1 KB to 25 MB. MP3, WAV and WebM are accepted; a non-audio body is
refused.

Creation is asynchronous. This call returns \`202\` at once with
\`status: processing\`. Poll \`GET /voices/{voice_id}\` until \`status\` is
\`ready\` or \`failed\`, then use the \`voice_id\` in an agent's \`voice\` config with
\`voice.provider: cartesia\`.

You must send \`consent: true\`: you confirm you have the right to clone
this voice. The attestation is recorded against the clone.

Limits apply per user: 5 clones an hour, 20 a day, and 200 stored
(processing plus ready). A request over a limit is refused with \`429\`.

(Tags: Voice cloning)`,
    inputSchema: {"type":"object","properties":{"Idempotency-Key":{"type":"string","description":"Optional. Send a unique value per clone; a retry with the same key\nand body returns the first clone instead of creating a second. Every\nclone costs money at the provider, so this makes a retry safe. Up to\n255 printable characters.\n"},"requestBody":{"type":"object","required":["name","clip","consent"],"properties":{"name":{"type":"string","description":"A name for the cloned voice, 1 to 100 characters."},"clip":{"type":"string","description":"Base64-encoded audio, 1 KB to 25 MB (MP3, WAV or WebM)."},"filename":{"type":"string","description":"Optional original filename, for your reference."},"description":{"type":"string","description":"Optional description."},"language":{"type":"string","description":"A short language code for the voice. Defaults to `en`."},"gender":{"type":"string","enum":["male","female"],"default":"female","description":"The voice's gender. Defaults to `female`."},"consent":{"type":"boolean","description":"Required and must be `true`: you confirm you have the right\nto clone this voice.\n"}},"description":"The JSON request body."}},"required":["requestBody"]},
    method: "post",
    pathTemplate: "/voices",
    executionParameters: [{"name":"Idempotency-Key","in":"header"}],
    requestBodyContentType: "application/json",
    securityRequirements: [{"BearerAuth":[]}],
    tags: ["Voice cloning"],
    deprecated: false
  }],
  ["getClonedVoice", {
    name: "getClonedVoice",
    description: `One cloned voice, including its creation \`status\`.
(Tags: Voice cloning)`,
    inputSchema: {"type":"object","properties":{"voice_id":{"type":"number","description":"Id of the cloned voice."}},"required":["voice_id"]},
    method: "get",
    pathTemplate: "/voices/{voice_id}",
    executionParameters: [{"name":"voice_id","in":"path"}],
    requestBodyContentType: undefined,
    securityRequirements: [{"BearerAuth":[]}],
    tags: ["Voice cloning"],
    deprecated: false
  }],
  ["deleteClonedVoice", {
    name: "deleteClonedVoice",
    description: `Delete a cloned voice and remove it from the provider. A voice that is
still \`processing\` cannot be deleted.

(Tags: Voice cloning)`,
    inputSchema: {"type":"object","properties":{"voice_id":{"type":"number","description":"Id of the cloned voice."}},"required":["voice_id"]},
    method: "delete",
    pathTemplate: "/voices/{voice_id}",
    executionParameters: [{"name":"voice_id","in":"path"}],
    requestBodyContentType: undefined,
    securityRequirements: [{"BearerAuth":[]}],
    tags: ["Voice cloning"],
    deprecated: false
  }],
  ["updateClonedVoice", {
    name: "updateClonedVoice",
    description: `Change the name, description or gender of a cloned voice.
(Tags: Voice cloning)`,
    inputSchema: {"type":"object","properties":{"voice_id":{"type":"number","description":"Id of the cloned voice."},"requestBody":{"type":"object","properties":{"name":{"type":"string","description":"1 to 100 characters."},"description":{"type":"string"},"gender":{"type":"string","enum":["male","female"]}},"description":"The JSON request body."}},"required":["voice_id","requestBody"]},
    method: "patch",
    pathTemplate: "/voices/{voice_id}",
    executionParameters: [{"name":"voice_id","in":"path"}],
    requestBodyContentType: "application/json",
    securityRequirements: [{"BearerAuth":[]}],
    tags: ["Voice cloning"],
    deprecated: false
  }],
  ["getClonedVoiceSample", {
    name: "getClonedVoiceSample",
    description: `Stream the generated mp3 sample of a cloned voice. Only the owner can
fetch it. \`404\` (\`sample_not_ready\`) when no sample exists yet. The
request needs your API key in the \`Authorization\` header.

(Tags: Voice cloning)`,
    inputSchema: {"type":"object","properties":{"voice_id":{"type":"number","description":"Id of the cloned voice."}},"required":["voice_id"]},
    method: "get",
    pathTemplate: "/voices/{voice_id}/sample",
    executionParameters: [{"name":"voice_id","in":"path"}],
    requestBodyContentType: undefined,
    securityRequirements: [{"BearerAuth":[]}],
    tags: ["Voice cloning"],
    deprecated: false
  }],
  ["regenerateClonedVoiceSample", {
    name: "regenerateClonedVoiceSample",
    description: `Regenerate the sample audio for a \`ready\` voice.
(Tags: Voice cloning)`,
    inputSchema: {"type":"object","properties":{"voice_id":{"type":"number","description":"Id of the cloned voice."}},"required":["voice_id"]},
    method: "post",
    pathTemplate: "/voices/{voice_id}/sample",
    executionParameters: [{"name":"voice_id","in":"path"}],
    requestBodyContentType: undefined,
    securityRequirements: [{"BearerAuth":[]}],
    tags: ["Voice cloning"],
    deprecated: false
  }],
  ["listWorkflowNodeTypes", {
    name: "listWorkflowNodeTypes",
    description: `Search the node types a workflow can use, such as \`whatsapp\`, \`voice_ai\` or \`conditional\`. Call it first when you do not know which node to add. Then call \`getWorkflowNodeType\` for the settings of one type.

(Tags: Workflows)`,
    inputSchema: {"type":"object","properties":{"q":{"type":"string","description":"Words to match against the type, label and description, such as `whatsapp`."},"category":{"type":"string","enum":["triggers","messaging","calls","flow","ai","crm","integrations"],"description":"Only types in this category."}}},
    method: "get",
    pathTemplate: "/workflow-node-types",
    executionParameters: [{"name":"q","in":"query"},{"name":"category","in":"query"}],
    requestBodyContentType: undefined,
    securityRequirements: [{"BearerAuth":[]}],
    tags: ["Workflows"],
    deprecated: false
  }],
  ["getWorkflowNodeType", {
    name: "getWorkflowNodeType",
    description: `The settings one node type reads, with their types, required flags and outputs. Call it before you add or edit a node, because its \`fields\` are the keys of the node's \`config\`. Use \`detail=full\` only when you need help text and examples.

(Tags: Workflows)`,
    inputSchema: {"type":"object","properties":{"node_type":{"type":"string","description":"A node type from `listWorkflowNodeTypes`, such as `whatsapp`."},"detail":{"type":"string","enum":["minimal","full"],"default":"minimal","description":"`full` adds descriptions, examples and `output_example`."}},"required":["node_type"]},
    method: "get",
    pathTemplate: "/workflow-node-types/{node_type}",
    executionParameters: [{"name":"node_type","in":"path"},{"name":"detail","in":"query"}],
    requestBodyContentType: undefined,
    securityRequirements: [{"BearerAuth":[]}],
    tags: ["Workflows"],
    deprecated: false
  }],
  ["listWorkflowFieldOptions", {
    name: "listWorkflowFieldOptions",
    description: `The choices for one \`ref\` field of a node type, such as the phone numbers, agents or integrations in your account. Call it for every \`ref\` field and never guess an id. If it returns \`400 no_options\`, the field is not chosen from a list, so ask the user for the value.

(Tags: Workflows)`,
    inputSchema: {"type":"object","properties":{"node_type":{"type":"string","description":"A node type from `listWorkflowNodeTypes`, such as `whatsapp`."},"field":{"type":"string","description":"A field name from `getWorkflowNodeType`."},"depends":{"type":"number","description":"The value of the field this one depends on (`depends_on` in the node type), such as the chosen phone number id."}},"required":["node_type","field"]},
    method: "get",
    pathTemplate: "/workflow-node-types/{node_type}/options/{field}",
    executionParameters: [{"name":"node_type","in":"path"},{"name":"field","in":"path"},{"name":"depends","in":"query"}],
    requestBodyContentType: undefined,
    securityRequirements: [{"BearerAuth":[]}],
    tags: ["Workflows"],
    deprecated: false
  }],
  ["listWorkflows", {
    name: "listWorkflows",
    description: `Your workflows, oldest first, one cursor page at a time. Use it to find a workflow id. Pass back \`next_cursor\` until it is \`null\`.

(Tags: Workflows)`,
    inputSchema: {"type":"object","properties":{"limit":{"type":"number","default":20,"minimum":1,"maximum":100,"description":"Rows per page."},"cursor":{"type":"string","description":"The `next_cursor` from the previous page. Omit it on the first request. Pass it back unchanged."}}},
    method: "get",
    pathTemplate: "/workflows",
    executionParameters: [{"name":"limit","in":"query"},{"name":"cursor","in":"query"}],
    requestBodyContentType: undefined,
    securityRequirements: [{"BearerAuth":[]}],
    tags: ["Workflows"],
    deprecated: false
  }],
  ["createWorkflow", {
    name: "createWorkflow",
    description: `Create a workflow with a draft. Without \`graph\`, the draft holds one \`trigger\` node, ready for \`editWorkflow\` ops. Pass \`graph\` only to start from a complete graph. The response carries the \`revision\` you need to edit.

(Tags: Workflows)`,
    inputSchema: {"type":"object","properties":{"requestBody":{"type":"object","required":["name"],"properties":{"name":{"type":"string","description":"A non-empty name."},"graph":{"type":"object","description":"A complete graph to start a workflow from, in the same shape `getWorkflow`\nreturns under `draft`. A workflow you read can be sent back as a new one.\nIt is built with the same checks as `editWorkflow` ops. Most callers skip it\nand build with `editWorkflow` instead.\n","required":["nodes","edges"],"properties":{"nodes":{"type":"array","items":{"type":"object","required":["id","type"],"properties":{"id":{"type":"string","description":"Lowercase letters, digits and underscores, starting with a letter. Later nodes read this node's output as `{{ context.<id>.<field> }}`."},"type":{"type":"string","description":"A node type from `listWorkflowNodeTypes`."},"label":{"type":"string"},"position":{"type":"object","properties":{"x":{"type":"number"},"y":{"type":"number"}}},"config":{"type":"object","additionalProperties":true,"description":"The node's settings. The fields come from `getWorkflowNodeType`."}}}},"edges":{"type":"array","items":{"type":"object","required":["from","to"],"properties":{"from":{"type":"string","description":"Id of the node the edge starts at."},"to":{"type":"string","description":"Id of the node the edge ends at."},"handle":{"type":"string","description":"The output of the `from` node. Omit it, or send `default`, for a plain node's only output."}}}}}}},"description":"The JSON request body."}},"required":["requestBody"]},
    method: "post",
    pathTemplate: "/workflows",
    executionParameters: [],
    requestBodyContentType: "application/json",
    securityRequirements: [{"BearerAuth":[]}],
    tags: ["Workflows"],
    deprecated: false
  }],
  ["getWorkflow", {
    name: "getWorkflow",
    description: `One workflow with its draft, status and \`revision\`. Call it before every edit to get the current \`revision\`. Use \`view=structure\` to see nodes and edges without config on a large workflow. Secrets read back as \`********\`.

(Tags: Workflows)`,
    inputSchema: {"type":"object","properties":{"workflow_id":{"type":"number","description":"Id of the workflow."},"view":{"type":"string","enum":["structure","full"],"default":"full","description":"`structure` leaves node `config` out."}},"required":["workflow_id"]},
    method: "get",
    pathTemplate: "/workflows/{workflow_id}",
    executionParameters: [{"name":"workflow_id","in":"path"},{"name":"view","in":"query"}],
    requestBodyContentType: undefined,
    securityRequirements: [{"BearerAuth":[]}],
    tags: ["Workflows"],
    deprecated: false
  }],
  ["deleteWorkflow", {
    name: "deleteWorkflow",
    description: `Delete a workflow. Its published version stops running. This cannot be undone, so confirm with the user first. To stop it without deleting, use \`deactivateWorkflow\`.

(Tags: Workflows)`,
    inputSchema: {"type":"object","properties":{"workflow_id":{"type":"number","description":"Id of the workflow."}},"required":["workflow_id"]},
    method: "delete",
    pathTemplate: "/workflows/{workflow_id}",
    executionParameters: [{"name":"workflow_id","in":"path"}],
    requestBodyContentType: undefined,
    securityRequirements: [{"BearerAuth":[]}],
    tags: ["Workflows"],
    deprecated: false
  }],
  ["editWorkflow", {
    name: "editWorkflow",
    description: `Change the draft with a list of \`ops\`: add, update, move or delete nodes, and connect or disconnect them. The ops apply all together or not at all. You must send the \`revision\` from your last read. If you get \`409 revision_conflict\`, read the workflow again and retry. Secrets read back as \`********\`. Send them back unchanged to keep the stored value. This edits the draft only. Use \`publishWorkflow\` to make it live.

(Tags: Workflows)`,
    inputSchema: {"type":"object","properties":{"workflow_id":{"type":"number","description":"Id of the workflow."},"requestBody":{"type":"object","required":["revision","ops"],"properties":{"revision":{"type":"string","description":"The `draft.revision` from your last `getWorkflow` or edit."},"ops":{"type":"array","items":{"type":"object","description":"One edit to the draft. Set `op` and the fields that op uses.\n\n| `op` | Fields | Effect |\n|---|---|---|\n| `add_node` | `id`, `type`, `label?`, `config?`, `after?`, `handle?`, `position?` | Adds a node. With `after`, it also connects it to that node (on output `handle`). |\n| `update_node` | `id`, `config?`, `label?` | Merges `config` keys into the node. A `null` value removes a key. |\n| `move_node` | `id`, `position` | Moves a node on the canvas. |\n| `delete_node` | `id` | Deletes a node and its edges. |\n| `connect` | `from`, `to`, `handle?` | Adds an edge. |\n| `disconnect` | `from`, `to`, `handle?` | Removes an edge. |\n","required":["op"],"properties":{"op":{"type":"string","enum":["add_node","update_node","move_node","delete_node","connect","disconnect"]},"id":{"type":"string","description":"Node id. For `add_node`, lowercase letters, digits and underscores, starting with a letter. It must be new."},"type":{"type":"string","description":"`add_node`: a node type from `listWorkflowNodeTypes`."},"label":{"type":"string","description":"`add_node`, `update_node`: the name shown on the canvas."},"config":{"type":"object","additionalProperties":true,"description":"`add_node`, `update_node`: the node's settings. The fields come from\n`getWorkflowNodeType`. Send a secret back as `********` to keep the\nstored value.\n"},"after":{"type":"string","description":"`add_node`: id of the node to connect the new node to."},"handle":{"type":"string","description":"`add_node`, `connect`, `disconnect`: the output of the source node. Omit for the default output."},"position":{"type":"object","description":"`add_node`, `move_node`: canvas position. `add_node` places the node for you if you omit it.","properties":{"x":{"type":"number"},"y":{"type":"number"}}},"from":{"type":"string","description":"`connect`, `disconnect`: id of the node the edge starts at."},"to":{"type":"string","description":"`connect`, `disconnect`: id of the node the edge ends at."}}}},"name":{"type":"string","description":"Rename the workflow."}},"description":"The JSON request body."}},"required":["workflow_id","requestBody"]},
    method: "patch",
    pathTemplate: "/workflows/{workflow_id}",
    executionParameters: [{"name":"workflow_id","in":"path"}],
    requestBodyContentType: "application/json",
    securityRequirements: [{"BearerAuth":[]}],
    tags: ["Workflows"],
    deprecated: false
  }],
  ["validateWorkflow", {
    name: "validateWorkflow",
    description: `Check the draft and list what blocks publish. It changes nothing. Call it after your edits and fix every error before \`publishWorkflow\`.

(Tags: Workflows)`,
    inputSchema: {"type":"object","properties":{"workflow_id":{"type":"number","description":"Id of the workflow."}},"required":["workflow_id"]},
    method: "post",
    pathTemplate: "/workflows/{workflow_id}/validate",
    executionParameters: [{"name":"workflow_id","in":"path"}],
    requestBodyContentType: undefined,
    securityRequirements: [{"BearerAuth":[]}],
    tags: ["Workflows"],
    deprecated: false
  }],
  ["publishWorkflow", {
    name: "publishWorkflow",
    description: `Make the draft the live version. Real events then run it, unless the workflow is paused. Run \`validateWorkflow\` first: publish is refused while the draft has errors. Ask the user before you publish.

(Tags: Workflows)`,
    inputSchema: {"type":"object","properties":{"workflow_id":{"type":"number","description":"Id of the workflow."}},"required":["workflow_id"]},
    method: "post",
    pathTemplate: "/workflows/{workflow_id}/publish",
    executionParameters: [{"name":"workflow_id","in":"path"}],
    requestBodyContentType: undefined,
    securityRequirements: [{"BearerAuth":[]}],
    tags: ["Workflows"],
    deprecated: false
  }],
  ["activateWorkflow", {
    name: "activateWorkflow",
    description: `Turn the published workflow on, so real events run it. Use it to resume a workflow you paused with \`deactivateWorkflow\`.

(Tags: Workflows)`,
    inputSchema: {"type":"object","properties":{"workflow_id":{"type":"number","description":"Id of the workflow."}},"required":["workflow_id"]},
    method: "post",
    pathTemplate: "/workflows/{workflow_id}/activate",
    executionParameters: [{"name":"workflow_id","in":"path"}],
    requestBodyContentType: undefined,
    securityRequirements: [{"BearerAuth":[]}],
    tags: ["Workflows"],
    deprecated: false
  }],
  ["deactivateWorkflow", {
    name: "deactivateWorkflow",
    description: `Turn the published workflow off, so real events stop running it. The workflow and its draft stay. Use \`activateWorkflow\` to turn it back on.

(Tags: Workflows)`,
    inputSchema: {"type":"object","properties":{"workflow_id":{"type":"number","description":"Id of the workflow."}},"required":["workflow_id"]},
    method: "post",
    pathTemplate: "/workflows/{workflow_id}/deactivate",
    executionParameters: [{"name":"workflow_id","in":"path"}],
    requestBodyContentType: undefined,
    securityRequirements: [{"BearerAuth":[]}],
    tags: ["Workflows"],
    deprecated: false
  }],
  ["testWorkflow", {
    name: "testWorkflow",
    description: `Runs the draft once with payload as the trigger data. Every node runs for real: WhatsApp messages, SMS, emails and calls go out and CRM records change. Ask the user before calling it, and use their own phone number or email in the payload.

It returns an \`execution_id\` at once. Poll \`getWorkflowExecution\` for the result.

(Tags: Workflows)`,
    inputSchema: {"type":"object","properties":{"workflow_id":{"type":"number","description":"Id of the workflow."},"requestBody":{"type":"object","properties":{"payload":{"type":"object","additionalProperties":true,"description":"The trigger data. Nodes read it as `{{ context.<trigger id>.<field> }}`. See `output_example` of the trigger node type for its shape."}},"description":"The JSON request body."}},"required":["workflow_id"]},
    method: "post",
    pathTemplate: "/workflows/{workflow_id}/test",
    executionParameters: [{"name":"workflow_id","in":"path"}],
    requestBodyContentType: "application/json",
    securityRequirements: [{"BearerAuth":[]}],
    tags: ["Workflows"],
    deprecated: false
  }],
  ["getWorkflowExecution", {
    name: "getWorkflowExecution",
    description: `One run of a workflow, with the result of each step. Use it to read the outcome of \`testWorkflow\`. A run is finished when \`state\` is \`completed\`, \`failed\` or \`cancelled\`.

(Tags: Workflows)`,
    inputSchema: {"type":"object","properties":{"workflow_id":{"type":"number","description":"Id of the workflow."},"execution_id":{"type":"number","description":"The `execution_id` from `testWorkflow`."}},"required":["workflow_id","execution_id"]},
    method: "get",
    pathTemplate: "/workflows/{workflow_id}/executions/{execution_id}",
    executionParameters: [{"name":"workflow_id","in":"path"},{"name":"execution_id","in":"path"}],
    requestBodyContentType: undefined,
    securityRequirements: [{"BearerAuth":[]}],
    tags: ["Workflows"],
    deprecated: false
  }],
  ["listWhatsappNumbers", {
    name: "listWhatsappNumbers",
    description: `The WhatsApp numbers your API key can see, oldest first. Use it to find
a number id, then pass that id to the other routes. Each number carries
\`capabilities\`, which says what it can send. Archived numbers are left
out.

(Tags: WhatsApp)`,
    inputSchema: {"type":"object","properties":{"limit":{"type":"number","default":20,"minimum":1,"maximum":100,"description":"Rows per page."},"cursor":{"type":"string","description":"The `next_cursor` from the previous page. Omit it on the first request and pass it back unchanged."}}},
    method: "get",
    pathTemplate: "/whatsapp/numbers",
    executionParameters: [{"name":"limit","in":"query"},{"name":"cursor","in":"query"}],
    requestBodyContentType: undefined,
    securityRequirements: [{"BearerAuth":[]}],
    tags: ["WhatsApp"],
    deprecated: false
  }],
  ["importWhatsappNumbers", {
    name: "importWhatsappNumbers",
    description: `Connects numbers from your own WhatsApp Business Account with your Meta
access token. List them first with
[Preview numbers](/docs/api-reference/whatsapp/previewWhatsappNumbers),
then pass the ids you want.

The token must never expire and must carry both WhatsApp permissions
(\`whatsapp_business_management\` and \`whatsapp_business_messaging\`). A
system user token does. Add \`app_secret\` to receive replies. Without
it the number can send but not receive.

Connecting a number again updates it: send a new \`access_token\` or
\`app_secret\` the same way to change either. One number failing does
not stop the others. It is listed in \`failed\` with the reason.

(Tags: WhatsApp)`,
    inputSchema: {"type":"object","properties":{"requestBody":{"type":"object","required":["waba_id","access_token","phone_number_ids"],"properties":{"waba_id":{"type":"string","description":"Your WhatsApp Business Account id, from WhatsApp Manager."},"access_token":{"type":"string","description":"A Meta access token that never expires, with both WhatsApp permissions. Stored, never returned."},"phone_number_ids":{"type":"array","minItems":1,"items":{"type":"string"},"description":"Meta's ids for the numbers to connect, as Preview numbers lists them."},"app_secret":{"type":"string","description":"Your Meta app's secret. Turns on replies. Stored, never returned."}},"description":"The JSON request body."}},"required":["requestBody"]},
    method: "post",
    pathTemplate: "/whatsapp/numbers",
    executionParameters: [],
    requestBodyContentType: "application/json",
    securityRequirements: [{"BearerAuth":[]}],
    tags: ["WhatsApp"],
    deprecated: false
  }],
  ["previewWhatsappNumbers", {
    name: "previewWhatsappNumbers",
    description: `Lists the numbers on your WhatsApp Business Account with their health,
and connects nothing. The access token is checked first, against the
same rules as connecting, so a preview that passes can connect.

Connect a number with \`needs_migration\` or \`needs_registration\` only
after fixing it in WhatsApp Manager, or its sends fail.

(Tags: WhatsApp)`,
    inputSchema: {"type":"object","properties":{"requestBody":{"type":"object","required":["waba_id","access_token"],"properties":{"waba_id":{"type":"string","description":"Your WhatsApp Business Account id, from WhatsApp Manager."},"access_token":{"type":"string","description":"A Meta access token that never expires, with both WhatsApp permissions."}},"description":"The JSON request body."}},"required":["requestBody"]},
    method: "post",
    pathTemplate: "/whatsapp/numbers/preview",
    executionParameters: [],
    requestBodyContentType: "application/json",
    securityRequirements: [{"BearerAuth":[]}],
    tags: ["WhatsApp"],
    deprecated: false
  }],
  ["getWhatsappNumber", {
    name: "getWhatsappNumber",
    description: `One number, with its status, quality and messaging limit, and what it
can send. A number in another workspace answers \`404\`.

(Tags: WhatsApp)`,
    inputSchema: {"type":"object","properties":{"number_id":{"type":"number","description":"Id of a WhatsApp number in your workspace, from\n[listWhatsappNumbers](/docs/api-reference/whatsapp/listWhatsappNumbers).\nA number in another workspace answers `404`.\n"}},"required":["number_id"]},
    method: "get",
    pathTemplate: "/whatsapp/numbers/{number_id}",
    executionParameters: [{"name":"number_id","in":"path"}],
    requestBodyContentType: undefined,
    securityRequirements: [{"BearerAuth":[]}],
    tags: ["WhatsApp"],
    deprecated: false
  }],
  ["listWhatsappTemplates", {
    name: "listWhatsappTemplates",
    description: `The number's message templates, as last synced, oldest first. Pass
\`status=approved\` to see exactly the templates a send accepts. Sync the
list with \`syncWhatsappTemplates\` first if a template you expect is
missing.

(Tags: WhatsApp)`,
    inputSchema: {"type":"object","properties":{"number_id":{"type":"number","description":"Id of a WhatsApp number in your workspace, from\n[listWhatsappNumbers](/docs/api-reference/whatsapp/listWhatsappNumbers).\nA number in another workspace answers `404`.\n"},"status":{"type":"string","description":"Show only templates with this review status, such as `approved`,\n`pending` or `rejected`. Lower-case; omit it for all.\n"},"limit":{"type":"number","default":20,"minimum":1,"maximum":100,"description":"Rows per page."},"cursor":{"type":"string","description":"The `next_cursor` from the previous page."}},"required":["number_id"]},
    method: "get",
    pathTemplate: "/whatsapp/numbers/{number_id}/templates",
    executionParameters: [{"name":"number_id","in":"path"},{"name":"status","in":"query"},{"name":"limit","in":"query"},{"name":"cursor","in":"query"}],
    requestBodyContentType: undefined,
    securityRequirements: [{"BearerAuth":[]}],
    tags: ["WhatsApp"],
    deprecated: false
  }],
  ["syncWhatsappTemplates", {
    name: "syncWhatsappTemplates",
    description: `Pull the number's templates and their review statuses from WhatsApp into
your list. Run it after you create or edit a template in Meta. It runs
at most once a minute per number: a second call inside that minute
answers \`429\`.

(Tags: WhatsApp)`,
    inputSchema: {"type":"object","properties":{"number_id":{"type":"number","description":"Id of a WhatsApp number in your workspace, from\n[listWhatsappNumbers](/docs/api-reference/whatsapp/listWhatsappNumbers).\nA number in another workspace answers `404`.\n"}},"required":["number_id"]},
    method: "post",
    pathTemplate: "/whatsapp/numbers/{number_id}/templates/sync",
    executionParameters: [{"name":"number_id","in":"path"}],
    requestBodyContentType: undefined,
    securityRequirements: [{"BearerAuth":[]}],
    tags: ["WhatsApp"],
    deprecated: false
  }],
  ["getWhatsappCalling", {
    name: "getWhatsappCalling",
    description: `Whether calling is on for this number and whether it can be turned on,
with the list of checks. A failing check does not fail the request: the
response stays \`200\` and names the check that blocks. Meta Cloud numbers
only. Calling must be included in your plan.

(Tags: WhatsApp)`,
    inputSchema: {"type":"object","properties":{"number_id":{"type":"number","description":"Id of a WhatsApp number in your workspace, from\n[listWhatsappNumbers](/docs/api-reference/whatsapp/listWhatsappNumbers).\nA number in another workspace answers `404`.\n"}},"required":["number_id"]},
    method: "get",
    pathTemplate: "/whatsapp/numbers/{number_id}/calling",
    executionParameters: [{"name":"number_id","in":"path"}],
    requestBodyContentType: undefined,
    securityRequirements: [{"BearerAuth":[]}],
    tags: ["WhatsApp"],
    deprecated: false
  }],
  ["setWhatsappCalling", {
    name: "setWhatsappCalling",
    description: `Turn calling on or off for a Meta Cloud number. A customer calls this
number; it does not place calls. Turning it on requires every blocking
check to pass, or the request answers \`409\`. Turning it off is always
allowed.

(Tags: WhatsApp)`,
    inputSchema: {"type":"object","properties":{"number_id":{"type":"number","description":"Id of a WhatsApp number in your workspace, from\n[listWhatsappNumbers](/docs/api-reference/whatsapp/listWhatsappNumbers).\nA number in another workspace answers `404`.\n"},"requestBody":{"type":"object","required":["enabled"],"properties":{"enabled":{"type":"boolean","description":"`true` to turn calling on, `false` to turn it off."}},"description":"The JSON request body."}},"required":["number_id","requestBody"]},
    method: "patch",
    pathTemplate: "/whatsapp/numbers/{number_id}/calling",
    executionParameters: [{"name":"number_id","in":"path"}],
    requestBodyContentType: "application/json",
    securityRequirements: [{"BearerAuth":[]}],
    tags: ["WhatsApp"],
    deprecated: false
  }],
  ["listWhatsappConversations", {
    name: "listWhatsappConversations",
    description: `A number's inbox, newest activity first. Poll it with \`updated_since\`
for changes since your last call, or page it with \`cursor\`. There are no
event webhooks, so polling is how an integration learns about new
messages.

(Tags: WhatsApp)`,
    inputSchema: {"type":"object","properties":{"number_id":{"type":"number","description":"Id of a WhatsApp number in your workspace, from\n[listWhatsappNumbers](/docs/api-reference/whatsapp/listWhatsappNumbers).\nA number in another workspace answers `404`.\n"},"filter":{"type":"string","enum":["all","unread","needs_person","agent","failed","window_closed","campaign_replies"],"default":"all","description":"`needs_person` is a person-owned or paused conversation. `window_closed` is one you can only reach with a template."},"q":{"type":"string","maxLength":200,"description":"Search the customer's name, phone number and message text."},"updated_since":{"type":"string","description":"An ISO 8601 date and time, such as `2026-10-01T09:00:00+00:00`. Returns\nconversations with a change at or after it. No offset means UTC.\n"},"limit":{"type":"number","default":20,"minimum":1,"maximum":100,"description":"Rows per page."},"cursor":{"type":"string","description":"The `next_cursor` from the previous page."}},"required":["number_id"]},
    method: "get",
    pathTemplate: "/whatsapp/numbers/{number_id}/conversations",
    executionParameters: [{"name":"number_id","in":"path"},{"name":"filter","in":"query"},{"name":"q","in":"query"},{"name":"updated_since","in":"query"},{"name":"limit","in":"query"},{"name":"cursor","in":"query"}],
    requestBodyContentType: undefined,
    securityRequirements: [{"BearerAuth":[]}],
    tags: ["WhatsApp"],
    deprecated: false
  }],
  ["getWhatsappConversation", {
    name: "getWhatsappConversation",
    description: `One conversation: who owns it, the 24-hour window, whether the customer
opted out, and the unread count. Poll it while a person is answering.

(Tags: WhatsApp)`,
    inputSchema: {"type":"object","properties":{"conversation_id":{"type":"string","description":"A conversation id: the number id, a dash, then the customer's phone\ndigits, such as `412-919876543210`. From\n[listWhatsappConversations](/docs/api-reference/whatsapp/listWhatsappConversations).\n"}},"required":["conversation_id"]},
    method: "get",
    pathTemplate: "/whatsapp/conversations/{conversation_id}",
    executionParameters: [{"name":"conversation_id","in":"path"}],
    requestBodyContentType: undefined,
    securityRequirements: [{"BearerAuth":[]}],
    tags: ["WhatsApp"],
    deprecated: false
  }],
  ["takeOverWhatsappConversation", {
    name: "takeOverWhatsappConversation",
    description: `Take the conversation from the agent, so it stops replying and your team
answers. Repeating it changes nothing. Hand it back with
\`handBackWhatsappConversation\` when the person is done.

(Tags: WhatsApp)`,
    inputSchema: {"type":"object","properties":{"conversation_id":{"type":"string","description":"A conversation id: the number id, a dash, then the customer's phone\ndigits, such as `412-919876543210`. From\n[listWhatsappConversations](/docs/api-reference/whatsapp/listWhatsappConversations).\n"}},"required":["conversation_id"]},
    method: "post",
    pathTemplate: "/whatsapp/conversations/{conversation_id}/take_over",
    executionParameters: [{"name":"conversation_id","in":"path"}],
    requestBodyContentType: undefined,
    securityRequirements: [{"BearerAuth":[]}],
    tags: ["WhatsApp"],
    deprecated: false
  }],
  ["handBackWhatsappConversation", {
    name: "handBackWhatsappConversation",
    description: `Give the conversation back to the agent, and clear a pause. The agent
answers the customer's next message. Repeating it changes nothing.

(Tags: WhatsApp)`,
    inputSchema: {"type":"object","properties":{"conversation_id":{"type":"string","description":"A conversation id: the number id, a dash, then the customer's phone\ndigits, such as `412-919876543210`. From\n[listWhatsappConversations](/docs/api-reference/whatsapp/listWhatsappConversations).\n"}},"required":["conversation_id"]},
    method: "post",
    pathTemplate: "/whatsapp/conversations/{conversation_id}/hand_back",
    executionParameters: [{"name":"conversation_id","in":"path"}],
    requestBodyContentType: undefined,
    securityRequirements: [{"BearerAuth":[]}],
    tags: ["WhatsApp"],
    deprecated: false
  }],
  ["listWhatsappMessages", {
    name: "listWhatsappMessages",
    description: `One conversation's messages, newest first. Poll forward with \`after\`
(the id of the newest message you already have) to get only new ones.
Page backward through history with \`cursor\`. Do not pass both.

(Tags: WhatsApp)`,
    inputSchema: {"type":"object","properties":{"conversation_id":{"type":"string","description":"The conversation to read."},"after":{"type":"number","description":"Return messages newer than this message id. `next_cursor` is null in this mode."},"limit":{"type":"number","default":20,"minimum":1,"maximum":100,"description":"Rows per page."},"cursor":{"type":"string","description":"The `next_cursor` from the previous page. Do not combine it with `after`."}},"required":["conversation_id"]},
    method: "get",
    pathTemplate: "/whatsapp/messages",
    executionParameters: [{"name":"conversation_id","in":"query"},{"name":"after","in":"query"},{"name":"limit","in":"query"},{"name":"cursor","in":"query"}],
    requestBodyContentType: undefined,
    securityRequirements: [{"BearerAuth":[]}],
    tags: ["WhatsApp"],
    deprecated: false
  }],
  ["sendWhatsappMessage", {
    name: "sendWhatsappMessage",
    description: `Send one message through \`phone_number_id\` to a customer, in a text,
a template, an image or a document. Set \`type\` and the matching field.

Outside the 24-hour window, only a template goes through. A text, image
or document send is refused with \`409 window_closed\`. A template send
works any time and can start a new conversation.

The send does not take the conversation over, so the agent keeps
answering. Set \`take_over: true\` to stop the agent and answer yourself.

\`Idempotency-Key\` is required. The same key with the same body replays
the first answer instead of sending again.

(Tags: WhatsApp)`,
    inputSchema: {"type":"object","properties":{"Idempotency-Key":{"type":"string","maxLength":255,"description":"A unique string you choose, up to 255 characters. Required on this\nroute. The same key with the same body replays the first answer for\n24 hours instead of acting twice. A different body with the same key\nanswers `409`.\n"},"requestBody":{"type":"object","required":["phone_number_id","to","type"],"properties":{"phone_number_id":{"type":"number","description":"The number to send from."},"to":{"type":"string","description":"The customer's number in international format, such as `+15551234567`."},"type":{"type":"string","enum":["text","template","image","document"]},"text":{"type":"string","maxLength":4096,"description":"Required when `type` is `text`."},"template":{"type":"object","description":"Required when `type` is `template`.","required":["id"],"properties":{"id":{"type":"number","description":"An approved template on this number, from `listWhatsappTemplates`."},"params":{"type":"object","description":"One value per field in the template's `fields`. Keys are\nthose field keys. String, number or null values.\n","additionalProperties":true}}},"media":{"type":"object","description":"Required when `type` is `image` or `document`.","required":["media_id"],"properties":{"media_id":{"type":"string","description":"The `media_id` from `uploadWhatsappMedia`, uploaded within the last 24 hours."},"caption":{"type":"string","maxLength":1024}}},"reply_to":{"type":"number","description":"A message id in the same conversation to quote. Not allowed with a template."},"take_over":{"type":"boolean","default":false,"description":"Stop the agent answering this conversation and let a person run it."}},"description":"The JSON request body."}},"required":["Idempotency-Key","requestBody"]},
    method: "post",
    pathTemplate: "/whatsapp/messages",
    executionParameters: [{"name":"Idempotency-Key","in":"header"}],
    requestBodyContentType: "application/json",
    securityRequirements: [{"BearerAuth":[]}],
    tags: ["WhatsApp"],
    deprecated: false
  }],
  ["getWhatsappMessage", {
    name: "getWhatsappMessage",
    description: `One message with its \`timeline\`: the delivery and read steps, oldest
first. Poll it after a send to learn whether the message was delivered
and read. Also shows what the send cost once it is charged.

(Tags: WhatsApp)`,
    inputSchema: {"type":"object","properties":{"message_id":{"type":"number","description":"Id of a message, from `listWhatsappMessages` or a send response."}},"required":["message_id"]},
    method: "get",
    pathTemplate: "/whatsapp/messages/{message_id}",
    executionParameters: [{"name":"message_id","in":"path"}],
    requestBodyContentType: undefined,
    securityRequirements: [{"BearerAuth":[]}],
    tags: ["WhatsApp"],
    deprecated: false
  }],
  ["uploadWhatsappMedia", {
    name: "uploadWhatsappMedia",
    description: `Upload an image or a document, then send it by its \`media_id\` on
\`sendWhatsappMessage\`. Uploading costs nothing; only the send is
charged. The \`media_id\` works for 24 hours and only for the number and
type it was uploaded for.

Images can be JPEG, PNG or WebP up to 5 MB. Documents can be PDF, DOCX,
XLSX or plain text up to 16 MB. The file's type is read from its bytes,
not its name.

(Tags: WhatsApp)`,
    inputSchema: {"type":"object","properties":{"requestBody":{"type":"string","description":"Request body (content type: multipart/form-data)"}},"required":["requestBody"]},
    method: "post",
    pathTemplate: "/whatsapp/media",
    executionParameters: [],
    requestBodyContentType: "multipart/form-data",
    securityRequirements: [{"BearerAuth":[]}],
    tags: ["WhatsApp"],
    deprecated: false
  }],
  ["listWhatsappOptOuts", {
    name: "listWhatsappOptOuts",
    description: `Who opted out of messages from this number, oldest first. By default it
lists active opt-outs only.

(Tags: WhatsApp)`,
    inputSchema: {"type":"object","properties":{"number_id":{"type":"number","description":"Id of a WhatsApp number in your workspace, from\n[listWhatsappNumbers](/docs/api-reference/whatsapp/listWhatsappNumbers).\nA number in another workspace answers `404`.\n"},"active":{"type":"string","enum":[true,false,"all"],"default":"true","description":"`true` for active only, `false` for lifted only, `all` for both."},"customer":{"type":"string","description":"Find one customer by any spelling of their number."},"limit":{"type":"number","default":20,"minimum":1,"maximum":100,"description":"Rows per page."},"cursor":{"type":"string","description":"The `next_cursor` from the previous page."}},"required":["number_id"]},
    method: "get",
    pathTemplate: "/whatsapp/numbers/{number_id}/opt_outs",
    executionParameters: [{"name":"number_id","in":"path"},{"name":"active","in":"query"},{"name":"customer","in":"query"},{"name":"limit","in":"query"},{"name":"cursor","in":"query"}],
    requestBodyContentType: undefined,
    securityRequirements: [{"BearerAuth":[]}],
    tags: ["WhatsApp"],
    deprecated: false
  }],
  ["addWhatsappOptOut", {
    name: "addWhatsappOptOut",
    description: `Stop every message you start to this customer from this number, until
the block is lifted. The response is \`201\` when the block is new and
\`200\` when the customer was already blocked, in which case the entry is
returned unchanged.

(Tags: WhatsApp)`,
    inputSchema: {"type":"object","properties":{"number_id":{"type":"number","description":"Id of a WhatsApp number in your workspace, from\n[listWhatsappNumbers](/docs/api-reference/whatsapp/listWhatsappNumbers).\nA number in another workspace answers `404`.\n"},"requestBody":{"type":"object","required":["customer"],"properties":{"customer":{"type":"string","description":"The customer's number in international format, such as `+15551234567`."},"note":{"type":"string","maxLength":500,"description":"A note for your team."}},"description":"The JSON request body."}},"required":["number_id","requestBody"]},
    method: "post",
    pathTemplate: "/whatsapp/numbers/{number_id}/opt_outs",
    executionParameters: [{"name":"number_id","in":"path"}],
    requestBodyContentType: "application/json",
    securityRequirements: [{"BearerAuth":[]}],
    tags: ["WhatsApp"],
    deprecated: false
  }],
  ["liftWhatsappOptOut", {
    name: "liftWhatsappOptOut",
    description: `Lift a block you added, or a marketing block made in WhatsApp. The entry
stays in the list with \`active: false\`. A customer's own STOP cannot be
lifted over the API: only the customer lifting it in WhatsApp, or
messaging you again, brings them back.

(Tags: WhatsApp)`,
    inputSchema: {"type":"object","properties":{"number_id":{"type":"number","description":"Id of a WhatsApp number in your workspace, from\n[listWhatsappNumbers](/docs/api-reference/whatsapp/listWhatsappNumbers).\nA number in another workspace answers `404`.\n"},"opt_out_id":{"type":"number","description":"Id of an active opt-out entry, from `listWhatsappOptOuts`."}},"required":["number_id","opt_out_id"]},
    method: "delete",
    pathTemplate: "/whatsapp/numbers/{number_id}/opt_outs/{opt_out_id}",
    executionParameters: [{"name":"number_id","in":"path"},{"name":"opt_out_id","in":"path"}],
    requestBodyContentType: undefined,
    securityRequirements: [{"BearerAuth":[]}],
    tags: ["WhatsApp"],
    deprecated: false
  }],
  ["listWhatsappCampaigns", {
    name: "listWhatsappCampaigns",
    description: `Your WhatsApp campaigns, oldest first. Filter by status or by number.

(Tags: WhatsApp)`,
    inputSchema: {"type":"object","properties":{"status":{"type":"string","enum":["draft","scheduled","in_progress","paused","completed","failed","cancelled"],"description":"Show only campaigns in this state."},"phone_number_id":{"type":"number","description":"Show only campaigns on this number."},"limit":{"type":"number","default":20,"minimum":1,"maximum":100,"description":"Rows per page."},"cursor":{"type":"string","description":"The `next_cursor` from the previous page."}}},
    method: "get",
    pathTemplate: "/whatsapp/campaigns",
    executionParameters: [{"name":"status","in":"query"},{"name":"phone_number_id","in":"query"},{"name":"limit","in":"query"},{"name":"cursor","in":"query"}],
    requestBodyContentType: undefined,
    securityRequirements: [{"BearerAuth":[]}],
    tags: ["WhatsApp"],
    deprecated: false
  }],
  ["createWhatsappCampaign", {
    name: "createWhatsappCampaign",
    description: `Create a campaign as a draft. It sends nothing until you launch it. Add
contacts and launch it in the next calls. Only an approved template can
be used, so every campaign starts with one. Scheduling is not offered.

(Tags: WhatsApp)`,
    inputSchema: {"type":"object","properties":{"requestBody":{"type":"object","required":["name","phone_number_id","template_id"],"properties":{"name":{"type":"string","maxLength":255},"phone_number_id":{"type":"number"},"template_id":{"type":"number","description":"An approved template on that number."},"campaign_mode":{"type":"string","enum":["broadcast","broadcast_reply"],"default":"broadcast","description":"`broadcast_reply` lets the agent answer replies. It needs an agent."},"agent_id":{"type":"number","description":"The agent that answers replies."},"data_source":{"type":"string","enum":["csv","webhook"],"default":"csv"},"is_dynamic":{"type":"boolean","default":false},"variable_mapping":{"type":"object","description":"Template field to contact field or static text.","additionalProperties":true}},"description":"The JSON request body."}},"required":["requestBody"]},
    method: "post",
    pathTemplate: "/whatsapp/campaigns",
    executionParameters: [],
    requestBodyContentType: "application/json",
    securityRequirements: [{"BearerAuth":[]}],
    tags: ["WhatsApp"],
    deprecated: false
  }],
  ["getWhatsappCampaign", {
    name: "getWhatsappCampaign",
    description: `One campaign with its counts and analytics: per-source figures and the
failed contacts grouped by reason. \`delivery_rate\` and \`read_rate\` are
null on a number that does not report receipts.

(Tags: WhatsApp)`,
    inputSchema: {"type":"object","properties":{"campaign_id":{"type":"number","description":"Id of a WhatsApp campaign, from `listWhatsappCampaigns`."}},"required":["campaign_id"]},
    method: "get",
    pathTemplate: "/whatsapp/campaigns/{campaign_id}",
    executionParameters: [{"name":"campaign_id","in":"path"}],
    requestBodyContentType: undefined,
    securityRequirements: [{"BearerAuth":[]}],
    tags: ["WhatsApp"],
    deprecated: false
  }],
  ["listWhatsappCampaignContacts", {
    name: "listWhatsappCampaignContacts",
    description: `Per-contact status for a campaign, oldest first. A contact that read the
message and then replied STOP counts as read and opted out.

(Tags: WhatsApp)`,
    inputSchema: {"type":"object","properties":{"campaign_id":{"type":"number","description":"Id of a WhatsApp campaign, from `listWhatsappCampaigns`."},"status":{"type":"string","enum":["pending","sent","delivered","read","replied","failed","skipped","opted_out"],"description":"Show only contacts in this state."},"limit":{"type":"number","default":20,"minimum":1,"maximum":100,"description":"Rows per page."},"cursor":{"type":"string","description":"The `next_cursor` from the previous page."}},"required":["campaign_id"]},
    method: "get",
    pathTemplate: "/whatsapp/campaigns/{campaign_id}/contacts",
    executionParameters: [{"name":"campaign_id","in":"path"},{"name":"status","in":"query"},{"name":"limit","in":"query"},{"name":"cursor","in":"query"}],
    requestBodyContentType: undefined,
    securityRequirements: [{"BearerAuth":[]}],
    tags: ["WhatsApp"],
    deprecated: false
  }],
  ["addWhatsappCampaignContacts", {
    name: "addWhatsappCampaignContacts",
    description: `Add one contact, or up to 500 at once. On a draft they are stored for
launch. On a running campaign they are sent now. A contact already in
the campaign is skipped, so a retry is safe. Each contact needs a
\`phone_number\`; every other key is kept and can fill a template
parameter through \`variable_mapping\`.

(Tags: WhatsApp)`,
    inputSchema: {"type":"object","properties":{"campaign_id":{"type":"number","description":"Id of a WhatsApp campaign, from `listWhatsappCampaigns`."},"requestBody":{"description":"One contact object, or an array of 1 to 500.","oneOf":[{"type":"object","description":"One contact. `phone_number` is required. Any other key is kept on the\ncontact and can fill a template parameter through `variable_mapping`.\n","required":["phone_number"],"properties":{"phone_number":{"type":"string","description":"The customer's number in international format, such as `+15551234567`."},"contact_name":{"type":"string","description":"A name for your team. `name` works too."}},"additionalProperties":true},{"type":"array","maxItems":500,"items":{"type":"object","description":"One contact. `phone_number` is required. Any other key is kept on the\ncontact and can fill a template parameter through `variable_mapping`.\n","required":["phone_number"],"properties":{"phone_number":{"type":"string","description":"The customer's number in international format, such as `+15551234567`."},"contact_name":{"type":"string","description":"A name for your team. `name` works too."}},"additionalProperties":true}}]}},"required":["campaign_id","requestBody"]},
    method: "post",
    pathTemplate: "/whatsapp/campaigns/{campaign_id}/contacts",
    executionParameters: [{"name":"campaign_id","in":"path"}],
    requestBodyContentType: "application/json",
    securityRequirements: [{"BearerAuth":[]}],
    tags: ["WhatsApp"],
    deprecated: false
  }],
  ["launchWhatsappCampaign", {
    name: "launchWhatsappCampaign",
    description: `Start a draft campaign: every pending contact is queued once. Needs at
least one contact, unless the campaign's \`data_source\` is \`webhook\`. The
plan's monthly broadcast allowance and the wallet balance are checked
here. \`Idempotency-Key\` is required, so a retry does not start it twice.

(Tags: WhatsApp)`,
    inputSchema: {"type":"object","properties":{"campaign_id":{"type":"number","description":"Id of a WhatsApp campaign, from `listWhatsappCampaigns`."},"Idempotency-Key":{"type":"string","maxLength":255,"description":"A unique string you choose, up to 255 characters. Required on this\nroute. The same key with the same body replays the first answer for\n24 hours instead of acting twice. A different body with the same key\nanswers `409`.\n"}},"required":["campaign_id","Idempotency-Key"]},
    method: "post",
    pathTemplate: "/whatsapp/campaigns/{campaign_id}/launch",
    executionParameters: [{"name":"campaign_id","in":"path"},{"name":"Idempotency-Key","in":"header"}],
    requestBodyContentType: undefined,
    securityRequirements: [{"BearerAuth":[]}],
    tags: ["WhatsApp"],
    deprecated: false
  }],
  ["pauseWhatsappCampaign", {
    name: "pauseWhatsappCampaign",
    description: `Stop sending until you resume. Only a running campaign can be paused. A
pause you make by hand is never resumed automatically.

(Tags: WhatsApp)`,
    inputSchema: {"type":"object","properties":{"campaign_id":{"type":"number","description":"Id of a WhatsApp campaign, from `listWhatsappCampaigns`."}},"required":["campaign_id"]},
    method: "post",
    pathTemplate: "/whatsapp/campaigns/{campaign_id}/pause",
    executionParameters: [{"name":"campaign_id","in":"path"}],
    requestBodyContentType: undefined,
    securityRequirements: [{"BearerAuth":[]}],
    tags: ["WhatsApp"],
    deprecated: false
  }],
  ["resumeWhatsappCampaign", {
    name: "resumeWhatsappCampaign",
    description: `Resume a paused campaign. Contacts still pending are sent; a contact
already sent is never sent again. The wallet and allowance are checked
again, so a resume can answer \`402\`.

(Tags: WhatsApp)`,
    inputSchema: {"type":"object","properties":{"campaign_id":{"type":"number","description":"Id of a WhatsApp campaign, from `listWhatsappCampaigns`."}},"required":["campaign_id"]},
    method: "post",
    pathTemplate: "/whatsapp/campaigns/{campaign_id}/resume",
    executionParameters: [{"name":"campaign_id","in":"path"}],
    requestBodyContentType: undefined,
    securityRequirements: [{"BearerAuth":[]}],
    tags: ["WhatsApp"],
    deprecated: false
  }],
  ["cancelWhatsappCampaign", {
    name: "cancelWhatsappCampaign",
    description: `Stop a campaign for good. Contacts not yet sent are not sent. A completed
or already-canceled campaign cannot be canceled.

(Tags: WhatsApp)`,
    inputSchema: {"type":"object","properties":{"campaign_id":{"type":"number","description":"Id of a WhatsApp campaign, from `listWhatsappCampaigns`."}},"required":["campaign_id"]},
    method: "post",
    pathTemplate: "/whatsapp/campaigns/{campaign_id}/cancel",
    executionParameters: [{"name":"campaign_id","in":"path"}],
    requestBodyContentType: undefined,
    securityRequirements: [{"BearerAuth":[]}],
    tags: ["WhatsApp"],
    deprecated: false
  }],
]);
addShowWorkflow(toolDefinitionMap);

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
    annotations: toolAnnotations(def),
    _meta: toolMeta(def.name)
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
