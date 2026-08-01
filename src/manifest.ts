import type { PaperclipPluginManifestV1 } from "@paperclipai/plugin-sdk";
import {
  ASK_HUMAN_TOOL_DECLARATION,
  DEFAULT_CONFIG,
  JOB_KEYS,
  PLUGIN_ID,
  PLUGIN_VERSION,
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
    "companies.read",
    "issues.read",
    "issues.create",
    "issue.comments.create",
    "issues.wakeup",
    "agents.read",
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
        type: "string",
        format: "secret-ref",
        title: "Slack Bot Token (secret reference)",
        description:
          "Secret UUID holding your Slack Bot OAuth token (xoxb-…). Create the secret in Settings → Secrets, then paste its UUID here.",
        default: DEFAULT_CONFIG.slackBotTokenRef,
      },
      slackAppTokenRef: {
        type: "string",
        format: "secret-ref",
        title: "Slack App-Level Token (secret reference)",
        description:
          "Secret UUID holding your Slack App-Level token (xapp-…) with the connections:write scope.",
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
        description: "Base URL of your Paperclip instance, used for dashboard links.",
        default: DEFAULT_CONFIG.paperclipBaseUrl,
      },
      sessionIdleHours: {
        type: "number",
        title: "Session Idle Hours",
        description: "Close agent sessions idle longer than this many hours.",
        default: DEFAULT_CONFIG.sessionIdleHours,
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
  tools: [ASK_HUMAN_TOOL_DECLARATION],
};

export default manifest;
