// Shared types for the Slack Socket Mode plugin.

import type { EnvSecretRefBinding } from "@paperclipai/plugin-sdk";

// `ctx.secrets.resolve` accepts either the shared `secret_ref` object shape
// from plugin config, or (per the SDK's documented legacy path) a plain
// string. Our config fields that hold a secret reference are typed this way
// and passed through to `resolve` completely opaquely — we must never
// inspect, reshape, or assume a string UUID here.
export type SecretRef = string | EnvSecretRefBinding;

// How a 1:1 DM with the bot is scoped. "channel": the whole DM is one
// continuous conversation (the bot remembers previous messages and replies
// top-level). "thread": every top-level DM message starts a fresh session
// and the reply is threaded under it — the pre-0.10.0 behavior. Channels,
// private channels and group DMs are ALWAYS thread-scoped; this setting
// does not touch them.
export type DmSessionMode = "channel" | "thread";

export interface SlackSocketConfig {
  slackBotTokenRef: SecretRef;
  slackAppTokenRef: SecretRef;
  paperclipApiKeyRef: SecretRef;
  companyId: string;
  defaultAgentId: string;
  defaultChannelId: string;
  notifyOnIssueCreated: boolean;
  notifyOnIssueDone: boolean;
  notifyOnAgentRunFailed: boolean;
  notifyOnApprovalCreated: boolean;
  issuesChannelId: string;
  errorsChannelId: string;
  approvalsChannelId: string;
  paperclipBaseUrl: string;
  sessionIdleHours: number;
  turnTimeoutMinutes: number;
  streamPartialReplies: boolean;
  chatPromptPreamble: string;
  dmSessionMode: DmSessionMode;
  /**
   * Seed a newly created session with the Slack thread it was mentioned in
   * (see buildSeedBlock in chat.ts). Default true: without it the agent
   * cannot answer "this issue here above" when the thread root was posted by
   * a different run through the slack_post_message tool and so was never
   * seen by this session. Off is the conservative setting — the agent then
   * only ever reads text addressed to it, at the cost of that question.
   */
  seedThreadHistory: boolean;
  allowedSlackUserIds: string[];
  // --- Agent-initiated posting (the slack_post_message tool) ---------
  //
  // NOTE the inverted emptiness semantics versus `allowedSlackUserIds`
  // above: that list is an INBOUND gate where empty means "no restriction
  // configured, everyone may drive the bot". These two lists are OUTBOUND
  // capability grants where empty means "nothing authorized". An outbound
  // capability that defaulted to "no restriction" would ship the plugin
  // able to post into every channel its bot can reach.
  agentPostMessageEnabled: boolean;
  agentPostToChannelsEnabled: boolean;
  agentPostChannelIds: string[];
  agentDmEnabled: boolean;
  agentDmUserIds: string[];
  agentDmAnyUser: boolean;
}

export interface SessionEntry {
  sessionId: string;
  channel: string;
  /**
   * The thread this session belongs to, or CHANNEL_SESSION_TS when `scope`
   * is "channel" (a 1:1 DM treated as one continuous conversation). Read
   * `scope`, not this field, to tell the two apart — that's why `scope`
   * exists rather than downstream code interpreting a sentinel.
   */
  threadTs: string;
  scope: "channel" | "thread";
  lastActivityAt: string; // ISO 8601
}

// Links a Slack message we posted to the entity it represents, so a later
// event can update that same message instead of posting a new one, and so
// the cleanup job can drop links nothing will ever touch again. See
// message-link.ts for the link/get/unlink/prune helpers.
export interface MessageLink {
  channel: string;
  ts: string;
  createdAt: string; // ISO 8601
}

/**
 * @deprecated Renamed to `MessageLink`. Issue threads were the first user of
 * this shape; approval messages are the second, which is what prompted the
 * rename. Identical shape — kept exported so existing imports (including
 * tests/cleanup.test.ts) keep compiling without being touched.
 */
export type IssueThreadEntry = MessageLink;

export type QuestionMode = "reaction" | "answer";

export interface PendingQuestion {
  channel: string;
  ts: string; // ts of the question message
  issueId: string;
  companyId: string;
  mode: QuestionMode;
  question: string;
  askedAt: string; // ISO 8601
  timeoutMinutes: number;
}

// --- Gateway (thin wrapper around Bolt; FakeGateway in tests) ---

export interface InboundMessage {
  channel: string;
  channelType: "im" | "channel" | "group";
  user: string;
  text: string;
  ts: string;
  threadTs?: string;
}

export interface InboundReaction {
  channel: string;
  messageTs: string;
  user: string;
  reaction: string; // emoji name without colons
}

export interface InboundAction {
  actionId: string;
  value: string;
  user: string;
  userName: string;
  channel: string;
  messageTs: string;
}

export interface InboundCommand {
  command: string; // e.g. "/paperclip"
  text: string;
  user: string;
  channel: string;
}

export interface OutboundMessage {
  channel: string;
  text: string;
  blocks?: unknown[];
  threadTs?: string;
}

/**
 * One message read back from a Slack thread. `isBot` is true only for
 * messages this app itself posted — including an alert another agent run
 * wrote through the `slack_post_message` tool — identified by the message's
 * Slack user id matching this gateway's own bot user id, so a transcript
 * can label it as the bot's own words rather than a third party's claim.
 *
 * `isBot` is deliberately NOT set merely because a message carries Slack's
 * `bot_id` field: any other integration (GitHub, Zapier, a workflow bot, …)
 * posts with a `bot_id` too, and conflating "posted by some bot" with
 * "posted by this app" would let a transcript misrepresent a third party's
 * words as the agent's own. A foreign bot's message keeps its own `user` id
 * in this shape, so a consumer can resolve and label it like any other
 * author instead of an anonymous one.
 */
export interface ThreadMessage {
  user: string;
  text: string;
  ts: string;
  isBot: boolean;
}

export interface SlackGateway {
  start(): Promise<void>;
  stop(): Promise<void>;
  isConnected(): boolean;
  botUserId(): string | undefined;
  /**
   * Independent liveness signal: an `auth.test` round-trip, false on any
   * failure. The worker's socket watchdog uses this so recovery never rests
   * solely on `isConnected()`, which is fed by listeners attached to Bolt's
   * private receiver internals (see bolt-gateway.ts) with optional chaining
   * and would silently never flip if Bolt's shape changed. It also catches a
   * revoked or rotated token on a socket Bolt still believes is open.
   */
  probe(): Promise<boolean>;
  postMessage(msg: OutboundMessage): Promise<{ channel: string; ts: string }>;
  updateMessage(msg: { channel: string; ts: string; text: string; blocks?: unknown[] }): Promise<void>;
  postEphemeral(msg: { channel: string; user: string; text: string }): Promise<void>;
  openDm(userId: string): Promise<string>;
  getUserDisplayName(userId: string): Promise<string>;
  /**
   * The messages of one thread, oldest first. `conversations.replies`
   * returns the parent plus only the oldest page of replies, so a single
   * call would seed a long thread with its opening and miss the recent
   * discussion — normally the part a person means by "this issue above".
   * Implementations page on `response_metadata.next_cursor` until Slack
   * reports no more pages or a hard cap of requests is reached, so a
   * runaway thread cannot hang a turn; bounding the returned transcript to
   * something a chat turn can use is the caller's job, not this method's.
   * `limit` is the page size passed to each underlying request, not a cap
   * on the total number of messages returned.
   *
   * Needs no OAuth scope beyond the `channels:history` / `groups:history` /
   * `im:history` already granted in slack-app-manifest.json, so this works
   * in public channels, private channels and 1:1 DMs. A multi-person group
   * DM (mpim) needs `mpim:history`, which this app does not grant; there
   * the call rejects with `missing_scope`, and callers should treat that as
   * "no history available" and proceed rather than fail the turn.
   */
  fetchThreadReplies(channel: string, threadTs: string, limit: number): Promise<ThreadMessage[]>;
  onMessage(handler: (msg: InboundMessage) => Promise<void>): void;
  onMention(handler: (msg: InboundMessage) => Promise<void>): void;
  onReaction(handler: (reaction: InboundReaction) => Promise<void>): void;
  onAction(pattern: RegExp, handler: (action: InboundAction) => Promise<void>): void;
  onCommand(command: string, handler: (cmd: InboundCommand) => Promise<void>): void;
}
