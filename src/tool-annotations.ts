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
  listAgentVersions: "List agent versions",
  createAgentVersion: "Save agent version",
  diffAgentVersion: "Diff agent version",
  restoreAgentVersion: "Restore agent version",
  renameAgentVersion: "Rename agent version",
  deleteAgentVersion: "Delete agent version",
  createSession: "Create voice session",
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
  startBulkCall: "Start draft campaign",
  addBulkCallContacts: "Add contacts to campaign",
  retryBulkCall: "Retry unconnected contacts",
  setBulkCallConcurrency: "Set campaign concurrency",
  setBulkCallDailyTimeControl: "Set campaign calling hours",
  listBulkCallLines: "List campaign call results",
  listBulkCallNumbers: "List campaign number pool",
  addBulkCallNumber: "Add number to campaign pool",
  setBulkCallNumberActive: "Pause or resume pool number",
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
  searchPhoneNumbers: "Search available phone numbers",
  purchasePhoneNumber: "Buy phone number",
  releasePhoneNumber: "Release phone number",
  getAccountBalance: "Get account balance",
  listClonedVoices: "List cloned voices",
  createClonedVoice: "Clone a voice",
  getClonedVoice: "Get cloned voice",
  updateClonedVoice: "Update cloned voice",
  deleteClonedVoice: "Delete cloned voice",
  getClonedVoiceSample: "Get cloned voice sample",
  regenerateClonedVoiceSample: "Regenerate cloned voice sample",
  listWorkflowNodeTypes: "List workflow node types",
  getWorkflowNodeType: "Get workflow node type",
  listWorkflowFieldOptions: "List choices for a workflow field",
  listWorkflows: "List workflows",
  createWorkflow: "Create workflow",
  getWorkflow: "Get workflow",
  showWorkflow: "Show workflow canvas",
  editWorkflow: "Edit workflow draft",
  deleteWorkflow: "Delete workflow",
  validateWorkflow: "Validate workflow",
  publishWorkflow: "Publish workflow",
  activateWorkflow: "Turn workflow on",
  deactivateWorkflow: "Turn workflow off",
  testWorkflow: "Test workflow (runs for real)",
  getWorkflowExecution: "Get workflow run",
  listPostCallActions: "List post-call actions",
  addPostCallAction: "Add a post-call action",
  deletePostCallAction: "Delete a post-call action",
  updatePostCallAction: "Update a post-call action",
  listIntegrations: "List integrations",
  createCustomApiIntegration: "Create custom API integration",
  createCalIntegration: "Connect Cal.com",
  listAgentIntegrations: "List agent integrations",
  attachAgentIntegration: "Attach integration to agent",
  detachAgentIntegration: "Detach integration from agent",
  setBulkCallRotation: "Set campaign number rotation",
  setPhoneNumberAutoRenew: "Set phone number auto-renew",
  listWhatsappNumbers: "List WhatsApp numbers",
  importWhatsappNumbers: "Import WhatsApp numbers",
  previewWhatsappNumbers: "Preview WhatsApp numbers to import",
  getWhatsappNumber: "Get WhatsApp number",
  listWhatsappTemplates: "List WhatsApp templates",
  syncWhatsappTemplates: "Sync WhatsApp templates",
  getWhatsappCalling: "Get WhatsApp calling setting",
  setWhatsappCalling: "Turn WhatsApp calling on or off",
  listWhatsappConversations: "List WhatsApp conversations",
  getWhatsappConversation: "Get WhatsApp conversation",
  takeOverWhatsappConversation: "Take over WhatsApp conversation",
  handBackWhatsappConversation: "Hand WhatsApp conversation back to agent",
  listWhatsappMessages: "List WhatsApp messages",
  sendWhatsappMessage: "Send WhatsApp message",
  getWhatsappMessage: "Get WhatsApp message",
  listWhatsappOptOuts: "List WhatsApp opt-outs",
  addWhatsappOptOut: "Add WhatsApp opt-out",
  liftWhatsappOptOut: "Lift WhatsApp opt-out",
  listWhatsappCampaigns: "List WhatsApp campaigns",
  createWhatsappCampaign: "Create WhatsApp campaign",
  getWhatsappCampaign: "Get WhatsApp campaign",
  listWhatsappCampaignContacts: "List WhatsApp campaign contacts",
  addWhatsappCampaignContacts: "Add contacts to WhatsApp campaign",
  launchWhatsappCampaign: "Launch WhatsApp campaign",
  pauseWhatsappCampaign: "Pause WhatsApp campaign",
  resumeWhatsappCampaign: "Resume WhatsApp campaign",
  cancelWhatsappCampaign: "Cancel WhatsApp campaign",
};

// POST tools that only validate or preview, with no state change.
const READ_ONLY_TOOLS = new Set(["canUploadFile", "validateWorkflow", "previewWhatsappNumbers"]);

// Irreversible removals, overwrites of live config, plus tools that place
// real outbound calls or send real messages.
const DESTRUCTIVE_TOOLS = new Set([
  "deleteAgent", "deleteAgentVersion", "restoreAgentVersion",
  "deleteKnowledgeBaseFile", "detachKnowledgeBaseFiles", "detachPhoneNumber",
  "cancelBulkCall", "dispatchCall", "createBulkCall", "addBulkCallContact",
  "addBulkCallContacts", "startBulkCall", "retryBulkCall",
  "purchasePhoneNumber", "releasePhoneNumber",
  "deleteClonedVoice", "deleteWorkflow", "publishWorkflow", "activateWorkflow",
  "deactivateWorkflow", "testWorkflow", "deletePostCallAction",
  "sendWhatsappMessage", "launchWhatsappCampaign", "resumeWhatsappCampaign",
  "addWhatsappCampaignContacts", "cancelWhatsappCampaign", "liftWhatsappOptOut",
  "importWhatsappNumbers", "attachAgentIntegration", "detachAgentIntegration",
  "setPhoneNumberAutoRenew",
]);

// Tools that reach people or systems outside our API: a carrier, Meta, or
// (attachAgentIntegration) a live agent calling a caller-supplied URL.
const OPEN_WORLD_TOOLS = new Set([
  "testWorkflow",
  "dispatchCall", "createBulkCall", "addBulkCallContact",
  "addBulkCallContacts", "startBulkCall", "retryBulkCall",
  "purchasePhoneNumber", "releasePhoneNumber",
  "sendWhatsappMessage", "launchWhatsappCampaign", "resumeWhatsappCampaign",
  "addWhatsappCampaignContacts", "importWhatsappNumbers", "setWhatsappCalling",
  "attachAgentIntegration",
]);

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
