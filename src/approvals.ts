import type { PluginContext } from "@paperclipai/plugin-sdk";
import { ACTION_IDS } from "./constants.js";
import { formatApprovalCreated, formatApprovalDecided } from "./formatters.js";
import { errString } from "./redact.js";
import type { InboundAction, SlackGateway, SlackSocketConfig } from "./types.js";

export interface ApprovalDeps {
  ctx: PluginContext;
  gateway: SlackGateway;
  getConfig: () => Promise<SlackSocketConfig>;
  /**
   * The single company this worker process is bound to — see the matching
   * comment on `NotificationDeps.companyId` in notifications.ts. The
   * `approval.created` subscription must be filtered to this company so a
   * shared worker process never reacts to another company's approvals.
   */
  companyId: string;
}

export interface Approvals {
  handleAction(action: InboundAction): Promise<void>;
}

export function createApprovals({ ctx, gateway, getConfig, companyId }: ApprovalDeps): Approvals {
  ctx.events.on("approval.created", { companyId }, async (event) => {
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
      await ctx.metrics.write("slack.notifications.sent", 1, { type: "approval_created" }).catch(() => {});
    } catch (err) {
      ctx.logger.warn("Slack approval notification failed", { err: errString(err) });
      await ctx.metrics.write("slack.notifications.failed", 1, { type: "approval_created" }).catch(() => {});
    }
  });

  async function postFailureEphemeral(
    action: InboundAction,
    approvalId: string,
    decision: "approve" | "reject",
    hint: string,
  ): Promise<void> {
    await gateway
      .postEphemeral({
        channel: action.channel,
        user: action.user,
        text: `:x: Failed to ${decision} approval \`${approvalId}\`. ${hint}`,
      })
      .catch(() => {});
  }

  return {
    async handleAction(action) {
      const cfg = await getConfig();
      const decision = action.actionId === ACTION_IDS.approvalApprove ? "approve" : "reject";
      const approvalId = action.value;

      if (!approvalId) {
        ctx.logger.warn("Approval action received with an empty value; ignoring", {
          actionId: action.actionId,
          user: action.user,
        });
        await gateway
          .postEphemeral({
            channel: action.channel,
            user: action.user,
            text: ":x: Could not process this action — no approval id was attached to the button.",
          })
          .catch(() => {});
        return;
      }

      // In `local_trusted` deployment mode every request is implicitly a
      // board actor, so no Authorization header is needed. In `authenticated`
      // mode the server requires a board API key to authenticate the
      // decision — resolve it only when the operator configured one.
      let authHeaders: Record<string, string> = {};
      if (cfg.paperclipApiKeyRef) {
        try {
          const apiKey = await ctx.secrets.resolve(cfg.paperclipApiKeyRef, { companyId: cfg.companyId });
          authHeaders = { Authorization: `Bearer ${apiKey}` };
        } catch (err) {
          ctx.logger.warn("Approval decision via Slack failed: could not resolve the Paperclip board API key", {
            err: errString(err),
            approvalId,
          });
          await postFailureEphemeral(
            action,
            approvalId,
            decision,
            "The configured Paperclip board API key could not be resolved — check the plugin settings.",
          );
          return;
        }
      }

      try {
        const response = await ctx.http.fetch(
          `${cfg.paperclipBaseUrl}/api/approvals/${encodeURIComponent(approvalId)}/${decision}`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json", ...authHeaders },
            // The server ignores decidedByUserId in the body (it uses the
            // authenticated actor) but does record decisionNote.
            body: JSON.stringify({
              decisionNote: `Decided via Slack by ${action.userName} (slack:${action.user})`,
            }),
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
        ctx.logger.warn("Approval decision via Slack failed", { err: errString(err), approvalId });
        await postFailureEphemeral(action, approvalId, decision, "It may already be decided.");
      }
    },
  };
}
