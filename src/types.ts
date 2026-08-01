// Shared types for the Slack Socket Mode plugin.

import type { EnvSecretRefBinding } from "@paperclipai/plugin-sdk";

// `ctx.secrets.resolve` accepts either the shared `secret_ref` object shape
// from plugin config, or (per the SDK's documented legacy path) a plain
// string. Our config fields that hold a secret reference are typed this way
// and passed through to `resolve` completely opaquely — we must never
// inspect, reshape, or assume a string UUID here.
export type SecretRef = string | EnvSecretRefBinding;

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
}

export interface SessionEntry {
  sessionId: string;
  channel: string;
  threadTs: string;
  lastActivityAt: string; // ISO 8601
}

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

export interface SlackGateway {
  start(): Promise<void>;
  stop(): Promise<void>;
  isConnected(): boolean;
  botUserId(): string | undefined;
  postMessage(msg: OutboundMessage): Promise<{ channel: string; ts: string }>;
  updateMessage(msg: { channel: string; ts: string; text: string; blocks?: unknown[] }): Promise<void>;
  postEphemeral(msg: { channel: string; user: string; text: string }): Promise<void>;
  openDm(userId: string): Promise<string>;
  getUserDisplayName(userId: string): Promise<string>;
  onMessage(handler: (msg: InboundMessage) => Promise<void>): void;
  onMention(handler: (msg: InboundMessage) => Promise<void>): void;
  onReaction(handler: (reaction: InboundReaction) => Promise<void>): void;
  onAction(pattern: RegExp, handler: (action: InboundAction) => Promise<void>): void;
  onCommand(command: string, handler: (cmd: InboundCommand) => Promise<void>): void;
}
