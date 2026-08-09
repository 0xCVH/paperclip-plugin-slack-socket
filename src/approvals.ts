import type { PluginContext } from "@paperclipai/plugin-sdk";
import { ACTION_IDS, STATE_KEYS } from "./constants.js";
import {
  formatApprovalCreated,
  formatApprovalDecided,
  formatApprovalDecidedElsewhere,
} from "./formatters.js";
import { getMessageLink, linkMessage, unlinkMessage } from "./message-link.js";
import { errString } from "./redact.js";
import type { InboundAction, SlackGateway, SlackSocketConfig } from "./types.js";

export interface ApprovalDeps {
  ctx: PluginContext;
  gateway: SlackGateway;
  getConfig: () => Promise<SlackSocketConfig>;
  /**
   * The single company this worker process is bound to — see the matching
   * comment on `NotificationDeps.companyId` in notifications.ts. The
   * `approval.created` and `approval.decided` subscriptions must both be
   * filtered to this company so a shared worker process never reacts to
   * another company's approvals.
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
    const approvalId = e.entityId;
    try {
      const posted = await gateway.postMessage({
        channel,
        ...formatApprovalCreated(approvalId, e.payload as Record<string, unknown>, cfg.paperclipBaseUrl),
      });
      await ctx.metrics.write("slack.notifications.sent", 1, { type: "approval_created" }).catch(() => {});
      // Remember where the message landed so a decision made anywhere else
      // can come back and retire its buttons. Its own catch, not the outer
      // one: the message did go out, so a state failure must not be
      // reported as a failed notification.
      await linkMessage(
        ctx,
        STATE_KEYS.approvalMessageIndex,
        STATE_KEYS.approvalMessage(approvalId),
        posted,
      ).catch((err: unknown) => {
        ctx.logger.warn("Failed to link the posted approval message", { err: errString(err), approvalId });
      });
    } catch (err) {
      ctx.logger.warn("Slack approval notification failed", { err: errString(err) });
      await ctx.metrics.write("slack.notifications.failed", 1, { type: "approval_created" }).catch(() => {});
    }
  });

  // A decision made outside this Slack message — the Paperclip web UI, the
  // API, another integration — must not leave live Approve/Reject buttons
  // sitting in the channel forever. Our own button clicks unlink before they
  // rewrite the message (see handleAction below), so the host's echo of our
  // own decision finds no link here and correctly no-ops.
  ctx.events.on("approval.decided", { companyId }, async (event) => {
    const e = event as { entityId?: string; payload: unknown };
    if (!e.entityId) return;
    const approvalId = e.entityId;
    const key = STATE_KEYS.approvalMessage(approvalId);
    const link = await getMessageLink(ctx, key);
    if (!link) return;
    try {
      await gateway.updateMessage({
        channel: link.channel,
        ts: link.ts,
        ...formatApprovalDecidedElsewhere(approvalId, e.payload as Record<string, unknown> | null),
      });
    } catch (err) {
      // Pre-existing failure mode, not a new one: the message keeps its
      // buttons and a later click lands on the "It may already be decided."
      // ephemeral below.
      ctx.logger.warn("Failed to sync a Slack approval message decided elsewhere", {
        err: errString(err),
        approvalId,
      });
    }
    // Dropped either way. The approval is decided, so nothing will ever
    // legitimately rewrite this message again, and a link kept alive after a
    // failed update would only sit there until the 30-day prune.
    await unlinkMessage(ctx, STATE_KEYS.approvalMessageIndex, key);
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
        // ORDER IS LOAD-BEARING: drop the link the instant the decision is
        // recorded, and BEFORE we write our own attribution. The host echoes
        // an `approval.decided` back for this very decision; with the link
        // already gone that handler no-ops instead of overwriting
        // "Approved by <name>" with generic decided-elsewhere text. Its own
        // catch, so a state failure can never make a decision that actually
        // succeeded report to the user as failed.
        await unlinkMessage(
          ctx,
          STATE_KEYS.approvalMessageIndex,
          STATE_KEYS.approvalMessage(approvalId),
        ).catch((err: unknown) => {
          ctx.logger.warn("Failed to unlink an approval message decided in Slack", {
            err: errString(err),
            approvalId,
          });
        });
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
