import type { PaperclipPluginManifestV1 } from "@paperclipai/plugin-sdk";
import {
  ASK_HUMAN_TOOL_DECLARATION,
  DEFAULT_CONFIG,
  JOB_KEYS,
  PLUGIN_ID,
  PLUGIN_VERSION,
  POST_MESSAGE_TOOL_DECLARATION,
} from "./constants.js";

const manifest: PaperclipPluginManifestV1 = {
  id: PLUGIN_ID,
  apiVersion: 1,
  version: PLUGIN_VERSION,
  displayName: "Slack (Socket Mode)",
  description:
    "Connect Slack over Socket Mode — no public URL required. Chat with a Paperclip agent in DMs and mentions, get configurable notifications, decide approvals with buttons, let agents ask humans questions, and create issues with /paperclip.",
  author: "cvh",
  categories: ["connector", "automation"],
  capabilities: [
    "issues.create",
    "issue.comments.create",
    "issues.wakeup",
    "agent.sessions.create",
    "agent.sessions.send",
    "agent.sessions.close",
    "agent.tools.register",
    "http.outbound",
    "events.subscribe",
    "plugin.state.read",
    "plugin.state.write",
    "secrets.read-ref",
    "instance.settings.register",
    "activity.log.write",
    "metrics.write",
    "jobs.schedule",
  ],
  entrypoints: {
    worker: "./dist/worker.js",
  },
  instanceConfigSchema: {
    type: "object",
    properties: {
      slackBotTokenRef: {
        // The host's secret picker stores a `{ type: "secret_ref", secretId,
        // version }` object, and ctx.secrets.resolve() fails closed on plain
        // UUID strings — so the object is the shape that actually works at
        // runtime. The string branch keeps the form's raw-input path valid.
        // The host validates the binding itself; constraining it further here
        // would reject valid shapes (e.g. a numeric `version` selector).
        type: ["string", "object"],
        format: "secret-ref",
        title: "Slack Bot Token (secret reference)",
        description:
          "Secret holding your Slack Bot OAuth token (xoxb-…). Create the secret in Settings → Secrets, then select it with the secret picker here.",
        default: DEFAULT_CONFIG.slackBotTokenRef,
      },
      slackAppTokenRef: {
        type: ["string", "object"],
        format: "secret-ref",
        title: "Slack App-Level Token (secret reference)",
        description:
          "Secret holding your Slack App-Level token (xapp-…) with the connections:write scope. Select it with the secret picker.",
        default: DEFAULT_CONFIG.slackAppTokenRef,
      },
      companyId: {
        type: "string",
        title: "Company ID",
        description: "Paperclip company UUID used for sessions, issues, and approvals.",
        default: DEFAULT_CONFIG.companyId,
      },
      defaultAgentId: {
        type: "string",
        title: "Default Agent ID",
        description: "Agent that handles DM and @mention conversations.",
        default: DEFAULT_CONFIG.defaultAgentId,
      },
      defaultChannelId: {
        type: "string",
        title: "Default Slack Channel ID",
        description: "Fallback channel for notifications (e.g. C01ABC2DEF3).",
        default: DEFAULT_CONFIG.defaultChannelId,
      },
      notifyOnIssueCreated: {
        type: "boolean",
        title: "Notify on issue created",
        default: DEFAULT_CONFIG.notifyOnIssueCreated,
      },
      notifyOnIssueDone: {
        type: "boolean",
        title: "Notify on issue completed",
        default: DEFAULT_CONFIG.notifyOnIssueDone,
      },
      notifyOnAgentRunFailed: {
        type: "boolean",
        title: "Notify on agent run failure",
        default: DEFAULT_CONFIG.notifyOnAgentRunFailed,
      },
      notifyOnApprovalCreated: {
        type: "boolean",
        title: "Notify on approval requested",
        default: DEFAULT_CONFIG.notifyOnApprovalCreated,
      },
      issuesChannelId: {
        type: "string",
        title: "Issues Channel ID",
        description: "Optional channel for issue notifications (falls back to default).",
        default: DEFAULT_CONFIG.issuesChannelId,
      },
      errorsChannelId: {
        type: "string",
        title: "Errors Channel ID",
        description: "Optional channel for agent failure notifications (falls back to default).",
        default: DEFAULT_CONFIG.errorsChannelId,
      },
      approvalsChannelId: {
        type: "string",
        title: "Approvals Channel ID",
        description: "Optional channel for approval notifications (falls back to default).",
        default: DEFAULT_CONFIG.approvalsChannelId,
      },
      paperclipBaseUrl: {
        type: "string",
        title: "Paperclip Base URL",
        description:
          "Base URL of your Paperclip instance. Load-bearing: used both to build dashboard links and as the target of the approval decision REST calls (POST {paperclipBaseUrl}/api/approvals/:id/approve|reject).",
        default: DEFAULT_CONFIG.paperclipBaseUrl,
      },
      paperclipApiKeyRef: {
        type: ["string", "object"],
        format: "secret-ref",
        title: "Paperclip Board API Key (secret reference)",
        description:
          "Secret reference holding a Paperclip API key for a board-role user, sent as an Authorization: Bearer header on approval decision requests. Leave empty for local_trusted deployments, where every request is implicitly authenticated as board and no header is needed. Required for authenticated deployments so approval decisions (Approve/Reject button clicks) authenticate as a board user.",
        default: DEFAULT_CONFIG.paperclipApiKeyRef,
      },
      sessionIdleHours: {
        type: "number",
        title: "Session Idle Hours",
        description: "Close agent sessions idle longer than this many hours.",
        default: DEFAULT_CONFIG.sessionIdleHours,
      },
      streamPartialReplies: {
        type: "boolean",
        title: "Stream partial replies",
        description:
          "When off (default), only the agent's final reply is posted to Slack. When on, raw adapter output is streamed live into the thread as it arrives — for some adapters (e.g. claude_local) this includes agent-runtime notices and the model's internal reasoning/deliberation, not just the final answer, so anyone in the thread can see it.",
        default: DEFAULT_CONFIG.streamPartialReplies,
      },
      chatPromptPreamble: {
        type: "string",
        title: "Chat prompt preamble",
        description:
          "Text prepended to every Slack chat message sent to the agent, to frame the turn as a conversation rather than autonomous work. Set to an empty string to send the user's message verbatim with no framing.",
        default: DEFAULT_CONFIG.chatPromptPreamble,
      },
      allowedSlackUserIds: {
        type: "array",
        items: { type: "string" },
        title: "Allowed Slack user IDs",
        description:
          "When empty (the default), the allowlist is disabled and any workspace member can use the bot. When non-empty, only the listed Slack user IDs (e.g. U01ABC2DEF3) can interact with it at all — everyone else is ignored silently, with no reply. Find a member's Slack user ID via their profile → \"Copy member ID\".",
        default: DEFAULT_CONFIG.allowedSlackUserIds,
      },
      agentPostMessageEnabled: {
        type: "boolean",
        title: "Let agents post to Slack",
        description:
          "Master switch for the slack_post_message tool. When off (the default), agents cannot post to Slack at all and every call is refused, regardless of the settings below.",
        default: DEFAULT_CONFIG.agentPostMessageEnabled,
      },
      agentPostToChannelsEnabled: {
        type: "boolean",
        title: "Allow agent posts to channels",
        description:
          "Allows agents to post to the channels listed below. Turn this off to suspend channel posting without clearing the list.",
        default: DEFAULT_CONFIG.agentPostToChannelsEnabled,
      },
      agentPostChannelIds: {
        type: "array",
        items: { type: "string" },
        title: "Agent-postable channel IDs",
        description:
          "Channel IDs (e.g. C01ABC2DEF3) that agents may post to. Empty means no channel may be posted to — unlike the inbound allowlist above, an empty list here authorizes nothing rather than removing the restriction. The bot must also be a member of the channel.",
        default: DEFAULT_CONFIG.agentPostChannelIds,
      },
      agentDmEnabled: {
        type: "boolean",
        title: "Allow agent DMs",
        description:
          "Allows agents to send direct messages. Turn this off to suspend DMs without clearing the list below.",
        default: DEFAULT_CONFIG.agentDmEnabled,
      },
      agentDmUserIds: {
        type: "array",
        items: { type: "string" },
        title: "Agent-DM-able user IDs",
        description:
          "Slack user IDs (e.g. U01ABC2DEF3) that agents may DM. Empty means no user may be DM'd. Ignored when \"Allow agent DMs to anyone\" is on.",
        default: DEFAULT_CONFIG.agentDmUserIds,
      },
      agentDmAnyUser: {
        type: "boolean",
        title: "Allow agent DMs to anyone",
        description:
          "When on, agents may DM any member of the workspace and the user list above is ignored. Still requires \"Allow agent DMs\" to be on.",
        default: DEFAULT_CONFIG.agentDmAnyUser,
      },
    },
    required: ["slackBotTokenRef", "slackAppTokenRef", "companyId", "defaultAgentId", "defaultChannelId"],
  },
  jobs: [
    {
      jobKey: JOB_KEYS.cleanup,
      displayName: "Cleanup idle sessions and expired questions",
      description: "Closes agent sessions idle beyond the configured TTL and expires unanswered ask-human questions.",
      schedule: "*/15 * * * *",
    },
  ],
  tools: [ASK_HUMAN_TOOL_DECLARATION, POST_MESSAGE_TOOL_DECLARATION],
};

export default manifest;
