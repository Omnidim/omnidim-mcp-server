export interface MergeGroup { description: string; field: string }
export interface MergeMember { tool: string; actions: string[]; passes: boolean }

export const MERGE_GROUPS: Record<string, MergeGroup> = {
  "agentIntegrationActions": {
    "description": "Attach an integration to an agent, or detach it.",
    "field": "action"
  },
  "agentVersionActions": {
    "description": "Rename, delete or restore one saved version of an agent.",
    "field": "action"
  },
  "bulkCallActions": {
    "description": "Start, cancel, pause, resume or reschedule a bulk-call campaign.",
    "field": "action"
  },
  "agentKnowledgeBaseActions": {
    "description": "Attach knowledge-base files to an agent, or detach them.",
    "field": "action"
  },
  "phoneNumberAgentActions": {
    "description": "Attach a phone number to an agent, or detach it from its agent.",
    "field": "action"
  },
  "listProviders": {
    "description": "List the LLM, speech-to-text or text-to-speech providers your organization can use, or all of them with their voices.",
    "field": "type"
  },
  "workflow": {
    "description": "Read workflows and their runs: list workflows, get one, validate a draft, list\na workflow's runs and read one, and look up node types and field choices.\n",
    "field": "action"
  },
  "workflowActions": {
    "description": "Create a workflow, edit its draft, publish it, test it, or turn it on or off.\nDeleting a workflow is its own tool, deleteWorkflow.\n",
    "field": "action"
  },
  "whatsappConversationActions": {
    "description": "Take a conversation from the agent so your team answers, or hand it back to the agent.",
    "field": "action"
  },
  "whatsappCampaignActions": {
    "description": "Launch, pause, resume or cancel a WhatsApp campaign.",
    "field": "action"
  }
};

export const MERGE_MEMBERS: Record<string, MergeMember> = {
  "attachAgentIntegration": {
    "tool": "agentIntegrationActions",
    "actions": [
      "attach"
    ],
    "passes": false
  },
  "detachAgentIntegration": {
    "tool": "agentIntegrationActions",
    "actions": [
      "detach"
    ],
    "passes": false
  },
  "renameAgentVersion": {
    "tool": "agentVersionActions",
    "actions": [
      "rename"
    ],
    "passes": false
  },
  "deleteAgentVersion": {
    "tool": "agentVersionActions",
    "actions": [
      "delete"
    ],
    "passes": false
  },
  "restoreAgentVersion": {
    "tool": "agentVersionActions",
    "actions": [
      "restore"
    ],
    "passes": false
  },
  "bulkCallActions": {
    "tool": "bulkCallActions",
    "actions": [
      "pause",
      "resume",
      "reschedule"
    ],
    "passes": true
  },
  "cancelBulkCall": {
    "tool": "bulkCallActions",
    "actions": [
      "cancel"
    ],
    "passes": false
  },
  "startBulkCall": {
    "tool": "bulkCallActions",
    "actions": [
      "start"
    ],
    "passes": false
  },
  "attachKnowledgeBaseFiles": {
    "tool": "agentKnowledgeBaseActions",
    "actions": [
      "attach"
    ],
    "passes": false
  },
  "detachKnowledgeBaseFiles": {
    "tool": "agentKnowledgeBaseActions",
    "actions": [
      "detach"
    ],
    "passes": false
  },
  "attachPhoneNumber": {
    "tool": "phoneNumberAgentActions",
    "actions": [
      "attach"
    ],
    "passes": false
  },
  "detachPhoneNumber": {
    "tool": "phoneNumberAgentActions",
    "actions": [
      "detach"
    ],
    "passes": false
  },
  "listLLMProviders": {
    "tool": "listProviders",
    "actions": [
      "llm"
    ],
    "passes": false
  },
  "listSTTProviders": {
    "tool": "listProviders",
    "actions": [
      "stt"
    ],
    "passes": false
  },
  "listTTSProviders": {
    "tool": "listProviders",
    "actions": [
      "tts"
    ],
    "passes": false
  },
  "listAllProviders": {
    "tool": "listProviders",
    "actions": [
      "all"
    ],
    "passes": false
  },
  "listWorkflowNodeTypes": {
    "tool": "workflow",
    "actions": [
      "node_types"
    ],
    "passes": false
  },
  "getWorkflowNodeType": {
    "tool": "workflow",
    "actions": [
      "node_type"
    ],
    "passes": false
  },
  "listWorkflowFieldOptions": {
    "tool": "workflow",
    "actions": [
      "field_options"
    ],
    "passes": false
  },
  "listWorkflows": {
    "tool": "workflow",
    "actions": [
      "list"
    ],
    "passes": false
  },
  "getWorkflow": {
    "tool": "workflow",
    "actions": [
      "get"
    ],
    "passes": false
  },
  "validateWorkflow": {
    "tool": "workflow",
    "actions": [
      "validate"
    ],
    "passes": false
  },
  "listWorkflowExecutions": {
    "tool": "workflow",
    "actions": [
      "runs"
    ],
    "passes": false
  },
  "getWorkflowExecution": {
    "tool": "workflow",
    "actions": [
      "run"
    ],
    "passes": false
  },
  "createWorkflow": {
    "tool": "workflowActions",
    "actions": [
      "create"
    ],
    "passes": false
  },
  "editWorkflow": {
    "tool": "workflowActions",
    "actions": [
      "edit"
    ],
    "passes": false
  },
  "publishWorkflow": {
    "tool": "workflowActions",
    "actions": [
      "publish"
    ],
    "passes": false
  },
  "activateWorkflow": {
    "tool": "workflowActions",
    "actions": [
      "activate"
    ],
    "passes": false
  },
  "deactivateWorkflow": {
    "tool": "workflowActions",
    "actions": [
      "deactivate"
    ],
    "passes": false
  },
  "testWorkflow": {
    "tool": "workflowActions",
    "actions": [
      "test"
    ],
    "passes": false
  },
  "takeOverWhatsappConversation": {
    "tool": "whatsappConversationActions",
    "actions": [
      "take_over"
    ],
    "passes": false
  },
  "handBackWhatsappConversation": {
    "tool": "whatsappConversationActions",
    "actions": [
      "hand_back"
    ],
    "passes": false
  },
  "launchWhatsappCampaign": {
    "tool": "whatsappCampaignActions",
    "actions": [
      "launch"
    ],
    "passes": false
  },
  "pauseWhatsappCampaign": {
    "tool": "whatsappCampaignActions",
    "actions": [
      "pause"
    ],
    "passes": false
  },
  "resumeWhatsappCampaign": {
    "tool": "whatsappCampaignActions",
    "actions": [
      "resume"
    ],
    "passes": false
  },
  "cancelWhatsappCampaign": {
    "tool": "whatsappCampaignActions",
    "actions": [
      "cancel"
    ],
    "passes": false
  }
};
