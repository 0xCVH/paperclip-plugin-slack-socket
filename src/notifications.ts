import type { PluginContext } from "@paperclipai/plugin-sdk";
import { STATE_KEYS, stateScope } from "./constants.js";
import { formatAgentRunFailed, formatIssueCreated, formatIssueDone, type SlackContent } from "./formatters.js";
import { errString } from "./redact.js";
import { updateIndex } from "./state-index.js";
import type { IssueThreadEntry, SlackGateway, SlackSocketConfig } from "./types.js";

export interface NotificationDeps {
  ctx: PluginContext;
  gateway: SlackGateway;
  getConfig: () => Promise<SlackSocketConfig>;
}

interface EventLike {
  entityId?: string;
  payload: unknown;
}

type NotificationType = "issue_created" | "issue_done" | "agent_run_failed";

export function registerNotifications({ ctx, gateway, getConfig }: NotificationDeps): void {
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

  ctx.events.on("issue.created", async (event) => {
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
      const key = STATE_KEYS.issueThread(issueId);
      const entry: IssueThreadEntry = {
        channel: posted.channel,
        ts: posted.ts,
        createdAt: new Date().toISOString(),
      };
      await ctx.state.set(stateScope(key), entry);
      await updateIndex(ctx, STATE_KEYS.issueThreadIndex, (current) =>
        current.includes(key) ? current : [...current, key],
      );
    }
  });

  ctx.events.on("issue.updated", async (event) => {
    const e = event as EventLike;
    const cfg = await getConfig();
    if (!cfg.notifyOnIssueDone) return;
    const payload = e.payload as Record<string, unknown> | null;
    if (payload?.status !== "done") return;
    const channel = cfg.issuesChannelId || cfg.defaultChannelId;
    if (!channel) return;

    const issueId = e.entityId ?? "";
    const key = issueId ? STATE_KEYS.issueThread(issueId) : null;
    const entry = key ? ((await ctx.state.get(stateScope(key))) as IssueThreadEntry | null) : null;

    if (entry && key && entry.channel === channel) {
      // Post the completion notice as a threaded reply on the original
      // "issue created" message, then the link is no longer needed — the
      // issue is finished.
      await post(channel, formatIssueDone(payload, issueId, cfg.paperclipBaseUrl), "issue_done", entry.ts);
      await ctx.state.delete(stateScope(key));
      await updateIndex(ctx, STATE_KEYS.issueThreadIndex, (current) => current.filter((k) => k !== key));
    } else {
      await post(channel, formatIssueDone(payload, issueId, cfg.paperclipBaseUrl), "issue_done");
    }
  });

  ctx.events.on("agent.run.failed", async (event) => {
    const e = event as EventLike;
    const cfg = await getConfig();
    if (!cfg.notifyOnAgentRunFailed) return;
    const channel = cfg.errorsChannelId || cfg.defaultChannelId;
    if (!channel) return;
    await post(channel, formatAgentRunFailed(e.payload as Record<string, unknown>), "agent_run_failed");
  });
}
