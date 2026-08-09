import type { PluginContext } from "@paperclipai/plugin-sdk";
import { STATE_KEYS } from "./constants.js";
import { formatAgentRunFailed, formatIssueCreated, formatIssueDone, type SlackContent } from "./formatters.js";
import { getMessageLink, linkMessage, unlinkMessage } from "./message-link.js";
import { errString } from "./redact.js";
import type { SlackGateway, SlackSocketConfig } from "./types.js";

export interface NotificationDeps {
  ctx: PluginContext;
  gateway: SlackGateway;
  getConfig: () => Promise<SlackSocketConfig>;
  /**
   * The single company this worker process is bound to. The host runs one
   * worker per installed plugin shared across every company that configures
   * it, so every `ctx.events.on` subscription must be filtered server-side
   * to this company — otherwise this process would receive (and act on)
   * every other company's events too.
   */
  companyId: string;
}

interface EventLike {
  entityId?: string;
  payload: unknown;
}

type NotificationType = "issue_created" | "issue_done" | "agent_run_failed";

export function registerNotifications({ ctx, gateway, getConfig, companyId }: NotificationDeps): void {
  const post = async (
    channel: string,
    content: SlackContent,
    type: NotificationType,
    threadTs?: string,
  ): Promise<{ channel: string; ts: string } | null> => {
    try {
      const posted = await gateway.postMessage({ channel, ...content, threadTs });
      await ctx.metrics.write("slack.notifications.sent", 1, { type }).catch(() => {});
      return posted;
    } catch (err) {
      ctx.logger.warn("Slack notification failed", { err: errString(err), channel });
      await ctx.metrics.write("slack.notifications.failed", 1, { type }).catch(() => {});
      return null;
    }
  };

  ctx.events.on("issue.created", { companyId }, async (event) => {
    const e = event as EventLike;
    const cfg = await getConfig();
    if (!cfg.notifyOnIssueCreated) return;
    const channel = cfg.issuesChannelId || cfg.defaultChannelId;
    if (!channel) return;
    const issueId = e.entityId ?? "";
    const posted = await post(
      channel,
      formatIssueCreated(e.payload as Record<string, unknown>, issueId, cfg.paperclipBaseUrl),
      "issue_created",
    );
    if (posted && issueId) {
      await linkMessage(ctx, STATE_KEYS.issueThreadIndex, STATE_KEYS.issueThread(issueId), posted);
    }
  });

  ctx.events.on("issue.updated", { companyId }, async (event) => {
    const e = event as EventLike;
    const cfg = await getConfig();
    if (!cfg.notifyOnIssueDone) return;
    const payload = e.payload as Record<string, unknown> | null;
    if (payload?.status !== "done") return;
    const channel = cfg.issuesChannelId || cfg.defaultChannelId;
    if (!channel) return;

    const issueId = e.entityId ?? "";
    const key = issueId ? STATE_KEYS.issueThread(issueId) : null;
    const entry = key ? await getMessageLink(ctx, key) : null;

    if (entry && key && entry.channel === channel) {
      // Post the completion notice as a threaded reply on the original
      // "issue created" message, then the link is no longer needed — the
      // issue is finished.
      await post(channel, formatIssueDone(payload, issueId, cfg.paperclipBaseUrl), "issue_done", entry.ts);
      await unlinkMessage(ctx, STATE_KEYS.issueThreadIndex, key);
    } else {
      await post(channel, formatIssueDone(payload, issueId, cfg.paperclipBaseUrl), "issue_done");
    }
  });

  ctx.events.on("agent.run.failed", { companyId }, async (event) => {
    const e = event as EventLike;
    const cfg = await getConfig();
    if (!cfg.notifyOnAgentRunFailed) return;
    const channel = cfg.errorsChannelId || cfg.defaultChannelId;
    if (!channel) return;
    await post(channel, formatAgentRunFailed(e.payload as Record<string, unknown>), "agent_run_failed");
  });
}
