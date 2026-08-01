import type { PluginContext } from "@paperclipai/plugin-sdk";
import { formatAgentRunFailed, formatIssueCreated, formatIssueDone, type SlackContent } from "./formatters.js";
import type { SlackGateway, SlackSocketConfig } from "./types.js";

export interface NotificationDeps {
  ctx: PluginContext;
  gateway: SlackGateway;
  getConfig: () => Promise<SlackSocketConfig>;
}

interface EventLike {
  entityId?: string;
  payload: unknown;
}

export function registerNotifications({ ctx, gateway, getConfig }: NotificationDeps): void {
  const post = async (channel: string, content: SlackContent): Promise<void> => {
    try {
      await gateway.postMessage({ channel, ...content });
    } catch (err) {
      ctx.logger.warn("Slack notification failed", { err: String(err), channel });
    }
  };

  ctx.events.on("issue.created", async (event) => {
    const e = event as EventLike;
    const cfg = await getConfig();
    if (!cfg.notifyOnIssueCreated) return;
    const channel = cfg.issuesChannelId || cfg.defaultChannelId;
    if (!channel) return;
    await post(
      channel,
      formatIssueCreated(e.payload as Record<string, unknown>, e.entityId ?? "", cfg.paperclipBaseUrl),
    );
  });

  ctx.events.on("issue.updated", async (event) => {
    const e = event as EventLike;
    const cfg = await getConfig();
    if (!cfg.notifyOnIssueDone) return;
    const payload = e.payload as Record<string, unknown> | null;
    if (payload?.status !== "done") return;
    const channel = cfg.issuesChannelId || cfg.defaultChannelId;
    if (!channel) return;
    await post(channel, formatIssueDone(payload, e.entityId ?? "", cfg.paperclipBaseUrl));
  });

  ctx.events.on("agent.run.failed", async (event) => {
    const e = event as EventLike;
    const cfg = await getConfig();
    if (!cfg.notifyOnAgentRunFailed) return;
    const channel = cfg.errorsChannelId || cfg.defaultChannelId;
    if (!channel) return;
    await post(channel, formatAgentRunFailed(e.payload as Record<string, unknown>));
  });
}
