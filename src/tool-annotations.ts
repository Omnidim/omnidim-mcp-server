// MCP tool annotations: a display title plus read-only / destructive /
// open-world hints, so clients can parallelize reads and confirm before
// destructive or real-world actions. Hand-authored (regen-safe); index.ts
// imports toolAnnotations and applies it in the tools/list handler.

// Human-readable display names, separate from the machine `name` the model sees.
const TOOL_TITLES: Record<string, string> = {
  listAgents: "List agents",
  createAgent: "Create agent",
  getAgent: "Get agent",
  updateAgent: "Update agent",
  deleteAgent: "Delete agent",
  dispatchCall: "Dispatch call",
  listCallLogs: "List call logs",
  getCallLog: "Get call log",
  fetchBulkCalls: "List bulk campaigns",
  createBulkCall: "Create bulk campaign",
  addBulkCallContact: "Add contact to campaign",
  getBulkCall: "Get bulk campaign",
  bulkCallActions: "Control bulk campaign",
  cancelBulkCall: "Cancel bulk campaign",
  getBulkCallLiveStatus: "Get campaign live status",
  listKnowledgeBaseFiles: "List knowledge base files",
  canUploadFile: "Check file upload eligibility",
  uploadKnowledgeBaseFile: "Upload knowledge base file",
  attachKnowledgeBaseFiles: "Attach knowledge base files",
  detachKnowledgeBaseFiles: "Detach knowledge base files",
  deleteKnowledgeBaseFile: "Delete knowledge base file",
  listPhoneNumbers: "List phone numbers",
  attachPhoneNumber: "Attach phone number",
  detachPhoneNumber: "Detach phone number",
  importTwilioNumber: "Import Twilio number",
  importExotelNumber: "Import Exotel number",
  importSipTrunk: "Import SIP trunk",
  listLLMProviders: "List LLM providers",
  listVoices: "List voices",
  listSTTProviders: "List speech-to-text providers",
  listTTSProviders: "List text-to-speech providers",
  listAllProviders: "List all providers",
  getVoice: "Get voice",
  listChildOrganizations: "List child organizations",
  addUser: "Add child user",
  setUserAccessControl: "Set user access control",
  setUserExpiry: "Set user expiry",
  setChildConcurrency: "Set child concurrency limit",
  calculateCreditOperation: "Preview credit operation",
  transferCreditsToChild: "Transfer credits to child",
  revertCreditsFromChild: "Revert credits from child",
  getResellerCreditLogs: "Get reseller credit logs",
};

// POST tools that only validate or preview, with no state change.
const READ_ONLY_TOOLS = new Set(["canUploadFile", "calculateCreditOperation"]);

// Irreversible removals plus tools that place real outbound calls.
const DESTRUCTIVE_TOOLS = new Set([
  "deleteAgent", "deleteKnowledgeBaseFile", "detachKnowledgeBaseFiles", "detachPhoneNumber",
  "cancelBulkCall", "revertCreditsFromChild", "dispatchCall", "createBulkCall", "addBulkCallContact",
]);

// Tools that reach the external phone network.
const OPEN_WORLD_TOOLS = new Set(["dispatchCall", "createBulkCall", "addBulkCallContact"]);

export interface ToolAnnotations {
  title?: string;
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  openWorldHint?: boolean;
}

// Spec defaults are conservative (destructiveHint and openWorldHint default to
// true), so set every hint explicitly to mark plain writes as safe.
export function toolAnnotations(def: { name: string; method: string }): ToolAnnotations {
  const annotations: ToolAnnotations = {};
  const title = TOOL_TITLES[def.name];
  if (title) annotations.title = title;
  const readOnly = def.method.toUpperCase() === "GET" || READ_ONLY_TOOLS.has(def.name);
  annotations.readOnlyHint = readOnly;
  if (readOnly) {
    annotations.openWorldHint = false;
  } else {
    annotations.destructiveHint = DESTRUCTIVE_TOOLS.has(def.name);
    annotations.openWorldHint = OPEN_WORLD_TOOLS.has(def.name);
  }
  return annotations;
}
