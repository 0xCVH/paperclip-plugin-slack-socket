import type { PluginContext } from "@paperclipai/plugin-sdk";
import { ACTION_IDS } from "./constants.js";
import { formatApprovalCreated, formatApprovalDecided } from "./formatters.js";
import type { InboundAction, SlackGateway, SlackSocketConfig } from "./types.js";

export interface ApprovalDeps {
  ctx: PluginContext;
  gateway: SlackGateway;
  getConfig: () => Promise<SlackSocketConfig>;
}

export interface Approvals {
  handleAction(action: InboundAction): Promise<void>;
}

export function createApprovals({ ctx, gateway, getConfig }: ApprovalDeps): Approvals {
  ctx.events.on("approval.created", async (event) => {
    const e = event as { entityId?: string; payload: unknown };
    const cfg = await getConfig();
    if (!cfg.notifyOnApprovalCreated || !e.entityId) return;
    const channel = cfg.approvalsChannelId || cfg.defaultChannelId;
    if (!channel) return;
    try {
      await gateway.postMessage({
        channel,
        ...formatApprovalCreated(e.entityId, e.payload as Record<string, unknown>, cfg.paperclipBaseUrl),
      });
    } catch (err) {
      ctx.logger.warn("Slack approval notification failed", { err: String(err) });
    }
  });

  return {
    async handleAction(action) {
      const cfg = await getConfig();
      const decision = action.actionId === ACTION_IDS.approvalApprove ? "approve" : "reject";
      const approvalId = action.value;
      try {
        const response = await ctx.http.fetch(
          `${cfg.paperclipBaseUrl}/api/approvals/${encodeURIComponent(approvalId)}/${decision}`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ decidedByUserId: `slack:${action.user}` }),
          },
        );
        if (response.status < 200 || response.status >= 300) {
          throw new Error(`Approval ${decision} returned HTTP ${response.status}`);
        }
        await gateway.updateMessage({
          channel: action.channel,
          ts: action.messageTs,
          ...formatApprovalDecided(approvalId, decision, action.userName),
        });
        await ctx.activity.log({
          companyId: cfg.companyId,
          message: `Approval ${approvalId} ${decision === "approve" ? "approved" : "rejected"} via Slack by ${action.userName} (slack:${action.user})`,
          entityType: "approval",
          entityId: approvalId,
        });
        await ctx.metrics.write("slack.approvals.decided", 1, { decision });
      } catch (err) {
        ctx.logger.warn("Approval decision via Slack failed", { err: String(err), approvalId });
        await gateway
          .postEphemeral({
            channel: action.channel,
            user: action.user,
            text: `:x: Failed to ${decision} approval \`${approvalId}\`. It may already be decided.`,
          })
          .catch(() => {});
      }
    },
  };
}
