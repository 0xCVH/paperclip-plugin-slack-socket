import type { PluginToolDeclaration, ScopeKey } from "@paperclipai/plugin-sdk";
import type { SlackSocketConfig } from "./types.js";

export const PLUGIN_ID = "cvh.slack-socket";
export const PLUGIN_VERSION = "0.11.3";

export const ACTION_IDS = {
  approvalApprove: "approval_approve",
  approvalReject: "approval_reject",
} as const;

export const JOB_KEYS = {
  cleanup: "cleanup",
} as const;

export const API_ROUTE_KEYS = {
  slackInbound: "slack-inbound",
} as const;

export const TOOL_NAMES = {
  askHuman: "ask_human",
  postMessage: "slack_post_message",
} as const;

export const SLASH_COMMAND = "/paperclip";

// The word that clears a conversation, spelled once so the slash subcommand
// (`/paperclip reset`) and the in-thread mention keyword (`@bot reset`)
// can never drift apart.
export const RESET_KEYWORD = "reset";

export const STATE_NAMESPACE = "slack-socket";

// Key suffix for a session scoped to a whole 1:1 DM channel rather than to
// one thread inside it (see resolveSessionScope in chat.ts). Exported so
// the reset command (commands.ts) rebuilds the same key the chat path
// wrote, instead of re-typing the literal.
export const CHANNEL_SESSION_TS = "main";

export const STATE_KEYS = {
  sessionIndex: "session-index",
  session: (channel: string, threadTs: string) => `session:${channel}:${threadTs}`,
  questionIndex: "question-index",
  question: (channel: string, ts: string) => `question:${channel}:${ts}`,
  issueThreadIndex: "issue-thread-index",
  issueThread: (issueId: string) => `issue-thread:${issueId}`,
  approvalMessageIndex: "approval-message-index",
  approvalMessage: (approvalId: string) => `approval-message:${approvalId}`,
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

export const POST_MESSAGE_TOOL_DECLARATION: PluginToolDeclaration = {
  name: TOOL_NAMES.postMessage,
  displayName: "Post a Slack message",
  description:
    "Post a message to a Slack channel, or DM a Slack user. Only the channels and users the operator has allowlisted in this plugin's settings can be targeted — any other target is refused. One-way: replies are not routed back to you, so use ask_human when you need an answer.",
  parametersSchema: {
    type: "object",
    properties: {
      target: {
        type: "string",
        description: "Slack channel ID (C…/G…) to post in, or Slack user ID (U…/W…) to DM.",
      },
      text: { type: "string", description: "Message body, in Markdown." },
      threadTs: {
        type: "string",
        description: "Optional ts of an existing message; posts this message as a reply beneath it.",
      },
    },
    required: ["target", "text"],
  },
};

// The tags an agent is instructed to wrap its actual reply in (see
// DEFAULT_CHAT_PROMPT_PREAMBLE below and chat.ts's extractReply). A prompt
// instruction alone ("don't narrate") isn't reliable — some adapters
// (e.g. claude_local) narrate about the instruction itself before
// answering, with no separator between the narration and the real reply.
// An explicit delimiter lets us extract the reply mechanically instead of
// guessing from line/paragraph heuristics, which real output has shown are
// unsafe (the narration can run directly into the answer with no boundary).
export const REPLY_OPEN_TAG = "<slack_reply>";
export const REPLY_CLOSE_TAG = "</slack_reply>";

// The fence a seeded thread transcript is wrapped in (see buildThreadContext
// in chat.ts). Seeding puts messages written by people who never addressed
// the bot in front of an agent holding slack_post_message, ask_human and
// issue-creation tools. The fence, plus the framing line inside it, is what
// tells the agent where that untrusted background starts and stops — so any
// literal occurrence of the close tag in a message must be neutralised
// before it is rendered, or content could close the fence early and continue
// in instruction position.
export const THREAD_CONTEXT_OPEN_TAG = "<thread_context>";
export const THREAD_CONTEXT_CLOSE_TAG = "</thread_context>";

// Bounds on how much thread history is seeded. Deliberately module
// constants, not config: nobody can tune these usefully until someone
// actually hits them, and every config field is a permanent support
// surface. The parent message's own text is separately capped at
// THREAD_CONTEXT_MAX_PARENT_CHARS and that truncated length counts against
// this overall budget — see selectThreadMessages.
export const THREAD_CONTEXT_MAX_CHARS = 12_000;
export const THREAD_CONTEXT_MAX_MESSAGES = 50;

// The per-request page size for reading a thread back (the `limit` passed to
// fetchThreadReplies), deliberately DECOUPLED from the selection cap above.
// conversations.replies pages oldest-first, so if the page size equalled the
// 50-message selection cap, a thread longer than THREAD_REPLIES_MAX_PAGES ×
// 50 = 250 messages would return only its oldest 250 — and selection, which
// keeps the most RECENT of what it was given, would then present a stale
// mid-thread window as "the recent discussion", the exact opposite of what
// "raise a ticket for this issue above" needs. Slack allows up to 1000 per
// page, so one page size of 1000 moves that cliff from 250 to 5000 messages
// (THREAD_REPLIES_MAX_PAGES × 1000) — beyond any realistic thread — while
// selection still trims the fetched transcript down to the 50-message /
// 12,000-char budget. The two numbers answer different questions: this is
// "how much can we read", THREAD_CONTEXT_MAX_MESSAGES is "how much do we keep".
export const THREAD_FETCH_PAGE_SIZE = 1_000;

// A single Slack message can carry up to ~40,000 characters. Without this,
// a maximal parent alone could blow past THREAD_CONTEXT_MAX_CHARS by more
// than 3x before a single reply is even considered — the parent is always
// kept (see selectThreadMessages), so unlike every other message it needs
// its own cap rather than relying on the overall budget to bound it.
export const THREAD_CONTEXT_MAX_PARENT_CHARS = 4_000;

// Prepended to every Slack chat message sent to the agent (see chat.ts's
// buildChatPrompt) to frame the turn as a conversation rather than
// autonomous work. Paperclip's heartbeat scaffolding frames every wake as
// autonomous work execution by default, which otherwise pushes agents into
// narrating their reasoning ("the wake payload shows reason: …") instead of
// just replying. It also instructs the agent to wrap its actual reply in
// <slack_reply>/</slack_reply> tags — see extractReply in chat.ts, which
// pulls only that content out and falls back to the full text when the
// tags are absent. Set to "" in config to send the user's message verbatim.
export const DEFAULT_CHAT_PROMPT_PREAMBLE =
  `You are replying to a person in a Slack thread. Answer them directly and conversationally, in your own voice, and keep it concise and readable as a chat message. Put your entire reply between ${REPLY_OPEN_TAG} and ${REPLY_CLOSE_TAG}, and put nothing else inside those tags — no reasoning, no restating the wake payload or execution contract, no notes about what you're about to do. Any thinking must go outside the tags; only what's inside them will be shown to the person.`;

export const DEFAULT_CONFIG: SlackSocketConfig = {
  slackBotTokenRef: "",
  slackAppTokenRef: "",
  companyId: "",
  defaultAgentId: "",
  additionalBots: [],
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
  turnTimeoutMinutes: 10,
  streamPartialReplies: false,
  chatPromptPreamble: DEFAULT_CHAT_PROMPT_PREAMBLE,
  // Default chosen because today's behavior is the defect: nothing depends
  // on the bot forgetting the previous line of a DM.
  dmSessionMode: "channel",
  // Default on: the defect it fixes is the common case. The switch exists
  // because the feature moves a trust boundary (the agent starts reading
  // messages from people who never addressed it) and some operators will
  // decline it — see the Security section of the design doc.
  seedThreadHistory: true,
  allowedSlackUserIds: [],
  agentPostMessageEnabled: false,
  agentPostToChannelsEnabled: false,
  agentPostChannelIds: [],
  agentDmEnabled: false,
  agentDmUserIds: [],
  agentDmAnyUser: false,
};
