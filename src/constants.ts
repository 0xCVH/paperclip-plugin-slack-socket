import type { PluginToolDeclaration, ScopeKey } from "@paperclipai/plugin-sdk";
import type { SlackSocketConfig } from "./types.js";

export const PLUGIN_ID = "cvh.slack-socket";
// The bot scopes slack-app-manifest.json requests — the feature set this
// plugin assumes a token carries. Compared at connect time against the
// x-oauth-scopes the token actually has (see BoltGateway.start): a scope
// dropped during a manual app edit otherwise fails silently as a dead
// feature. A test pins this list to the checked-in manifest so the two
// cannot drift.
export const REQUIRED_BOT_SCOPES = [
  "app_mentions:read",
  "chat:write",
  "channels:history",
  "groups:history",
  "im:history",
  "im:read",
  "im:write",
  "reactions:read",
  "users:read",
  "commands",
] as const;

export const PLUGIN_VERSION = "0.13.1";

export const ACTION_IDS = {
  approvalApprove: "approval_approve",
  approvalReject: "approval_reject",
} as const;

export const JOB_KEYS = {
  cleanup: "cleanup",
} as const;

export const TOOL_NAMES = {
  askHuman: "ask_human",
  postMessage: "slack_post_message",
  recordOnIssue: "record_on_issue",
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
  // Reverse of issueThread: the Slack thread root -> the issue it was posted
  // for. record_on_issue reads this to find a thread's own issue without
  // scanning every issue-thread entry.
  threadIssueIndex: "thread-issue-index",
  threadIssue: (channel: string, ts: string) => `thread-issue:${channel}:${ts}`,
  // Top-level messages this bot posted with agent-written text
  // (slack_post_message, ask_human, a channel-scoped DM reply). The bot
  // posts them, but an agent chose the words, so record_on_issue must never
  // read an issue link in one of them as "this thread's issue".
  agentPostIndex: "agent-post-index",
  agentPost: (channel: string, ts: string) => `agent-post:${channel}:${ts}`,
  // Heartbeat run -> the Slack thread it is serving (see chat-run-binding.ts).
  chatRunIndex: "chat-run-index",
  chatRun: (runId: string) => `chat-run:${runId}`,
  chatRunWrites: (runId: string) => `chat-run-writes:${runId}`,
  // A Slack @mention the relay has already written onto an issue (see
  // mention-relay.ts). Socket Mode redelivers events at least once and a
  // restart empties the in-memory deduper; this record is what keeps a
  // redelivered mention from landing on the issue twice.
  relayedMentionIndex: "relayed-mention-index",
  relayedMention: (channel: string, ts: string) => `relayed-mention:${channel}:${ts}`,
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

export const RECORD_ON_ISSUE_TOOL_DECLARATION: PluginToolDeclaration = {
  name: TOOL_NAMES.recordOnIssue,
  displayName: "Record a Slack conversation on an issue",
  description:
    "Write a comment onto a Paperclip issue from a Slack conversation. This is the only way to put " +
    "something on an issue while you are answering in Slack — the issues REST API refuses writes from " +
    "Slack chat runs. When a person @mentions you in a thread that belongs to an issue, the plugin has " +
    "already recorded their message on that issue before your turn began — your prompt says so — so use " +
    "this only for something else: a note of your own, or an issue a human named. " +
    "The target must be this thread's own issue (the issue the thread was posted for), " +
    "or an issue a human named in this thread. A footer saying it was relayed from Slack is added " +
    "automatically, and the issue's assignee is woken unless wakeAssignee is false. A refusal (a result " +
    "with a `code`) is final: do not retry it and do not try the REST API instead — tell the person in " +
    "Slack what was refused and why.",
  parametersSchema: {
    type: "object",
    properties: {
      issue: { type: "string", description: "Issue identifier (e.g. POL-3267) or issue UUID." },
      body: { type: "string", description: "Comment body in Markdown, 1–8000 characters." },
      wakeAssignee: {
        type: "boolean",
        description: "Wake the issue's assignee after writing (default true).",
      },
    },
    required: ["issue", "body"],
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
  // Default on: a person's @mention in an issue's thread is meant for that
  // issue's owner, and only the plugin can put it there (see
  // mention-relay.ts). Off, the agent still learns which issue the thread
  // is about; nothing is written.
  relayMentionsToIssue: true,
  allowedSlackUserIds: [],
  agentPostMessageEnabled: false,
  agentPostToChannelsEnabled: false,
  agentPostChannelIds: [],
  agentDmEnabled: false,
  agentDmUserIds: [],
  agentDmAnyUser: false,
};
