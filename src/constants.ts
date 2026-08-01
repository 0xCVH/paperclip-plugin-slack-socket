import type { PluginToolDeclaration, ScopeKey } from "@paperclipai/plugin-sdk";
import type { SlackSocketConfig } from "./types.js";

export const PLUGIN_ID = "cvh.slack-socket";
export const PLUGIN_VERSION = "0.5.0";

export const ACTION_IDS = {
  approvalApprove: "approval_approve",
  approvalReject: "approval_reject",
} as const;

export const JOB_KEYS = {
  cleanup: "cleanup",
} as const;

export const TOOL_NAMES = {
  askHuman: "ask_human",
} as const;

export const SLASH_COMMAND = "/paperclip";

export const STATE_NAMESPACE = "slack-socket";

export const STATE_KEYS = {
  sessionIndex: "session-index",
  session: (channel: string, threadTs: string) => `session:${channel}:${threadTs}`,
  questionIndex: "question-index",
  question: (channel: string, ts: string) => `question:${channel}:${ts}`,
  issueThreadIndex: "issue-thread-index",
  issueThread: (issueId: string) => `issue-thread:${issueId}`,
} as const;

export function stateScope(stateKey: string): ScopeKey {
  return { scopeKind: "instance", namespace: STATE_NAMESPACE, stateKey };
}

export const ASK_HUMAN_TOOL_DECLARATION: PluginToolDeclaration = {
  name: TOOL_NAMES.askHuman,
  displayName: "Ask a human via Slack",
  description:
    "Post a question to a Slack channel or user (DM). mode 'reaction' asks the human to react with an emoji; mode 'answer' asks for a text reply in the question's thread. The response is recorded as a comment on the given issue and the issue's assignee is woken.",
  parametersSchema: {
    type: "object",
    properties: {
      question: { type: "string", description: "The question to ask." },
      target: {
        type: "string",
        description: "Slack channel ID (C…) to post in, or Slack user ID (U…) to DM.",
      },
      mode: { type: "string", enum: ["reaction", "answer"] },
      issueId: { type: "string", description: "Paperclip issue UUID the response is recorded on." },
      timeoutMinutes: {
        type: "number",
        description: "Minutes to wait before marking the question expired (default 1440).",
      },
    },
    required: ["question", "target", "mode", "issueId"],
  },
};

// Prepended to every Slack chat message sent to the agent (see chat.ts's
// buildChatPrompt) to frame the turn as a conversation rather than
// autonomous work. Paperclip's heartbeat scaffolding frames every wake as
// autonomous work execution by default, which otherwise pushes agents into
// narrating their reasoning ("the wake payload shows reason: …") instead of
// just replying. Set to "" in config to send the user's message verbatim.
export const DEFAULT_CHAT_PROMPT_PREAMBLE =
  "You are replying to a person in a Slack thread. Answer them directly and conversationally, in your own voice. Do not narrate your reasoning, restate the wake payload or execution contract, or list what you should do — just reply. Keep it concise and readable as a chat message.";

export const DEFAULT_CONFIG: SlackSocketConfig = {
  slackBotTokenRef: "",
  slackAppTokenRef: "",
  companyId: "",
  defaultAgentId: "",
  defaultChannelId: "",
  notifyOnIssueCreated: true,
  notifyOnIssueDone: true,
  notifyOnAgentRunFailed: true,
  notifyOnApprovalCreated: true,
  issuesChannelId: "",
  errorsChannelId: "",
  approvalsChannelId: "",
  paperclipApiKeyRef: "",
  paperclipBaseUrl: "http://localhost:3010",
  sessionIdleHours: 24,
  streamPartialReplies: false,
  chatPromptPreamble: DEFAULT_CHAT_PROMPT_PREAMBLE,
};
