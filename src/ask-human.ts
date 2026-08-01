import type { PluginContext } from "@paperclipai/plugin-sdk";
import { ASK_HUMAN_TOOL_DECLARATION, STATE_KEYS, TOOL_NAMES, stateScope } from "./constants.js";
import { formatQuestion, formatQuestionResolved } from "./formatters.js";
import { updateIndex } from "./state-index.js";
import type { InboundMessage, InboundReaction, PendingQuestion, SlackGateway } from "./types.js";

export interface AskHumanDeps {
  ctx: PluginContext;
  gateway: SlackGateway;
}

export interface AskHuman {
  registerTool(): void;
  /** Returns true when the message was an answer to a pending question (callers must stop routing it). */
  tryHandleAnswer(msg: InboundMessage): Promise<boolean>;
  handleReaction(reaction: InboundReaction): Promise<void>;
}

export function createAskHuman({ ctx, gateway }: AskHumanDeps): AskHuman {
  // Same-process claim guard against the double-resolution race: two
  // near-simultaneous events for the same pending question (e.g. a reaction
  // and a thread reply, or two overlapping reactions) can both pass the
  // "pending exists" read before either has written its resolution. Callers
  // must check-and-add this set synchronously (no await in between) right
  // after confirming the event matches a pending question, so only the
  // first in-flight resolution for a given key proceeds.
  const claimed = new Set<string>();

  async function resolvePending(
    key: string,
    pending: PendingQuestion,
    response: string,
    responderName: string,
  ): Promise<void> {
    const body = `Slack response from ${responderName} to: "${pending.question}"\n\n${response}`;
    await ctx.issues.createComment(pending.issueId, body, pending.companyId);
    try {
      await ctx.issues.requestWakeup(pending.issueId, pending.companyId, {
        reason: "slack_ask_human_response",
        contextSource: "slack-socket.ask-human",
      });
    } catch (err) {
      ctx.logger.warn("Wakeup after Slack answer failed", { err: String(err), issueId: pending.issueId });
    }
    await gateway.updateMessage({
      channel: pending.channel,
      ts: pending.ts,
      ...formatQuestionResolved(pending.question, response, responderName),
    });
    await ctx.state.delete(stateScope(key));
    await updateIndex(ctx, STATE_KEYS.questionIndex, (current) => current.filter((k) => k !== key));
    await ctx.metrics.write("slack.questions.answered", 1, { mode: pending.mode });
  }

  return {
    registerTool() {
      ctx.tools.register(
        TOOL_NAMES.askHuman,
        {
          displayName: ASK_HUMAN_TOOL_DECLARATION.displayName,
          description: ASK_HUMAN_TOOL_DECLARATION.description,
          parametersSchema: ASK_HUMAN_TOOL_DECLARATION.parametersSchema,
        },
        async (params, runCtx) => {
          const p = (params ?? {}) as Record<string, unknown>;
          const question = typeof p.question === "string" ? p.question.trim() : "";
          const target = typeof p.target === "string" ? p.target.trim() : "";
          const mode = p.mode === "reaction" || p.mode === "answer" ? p.mode : null;
          const issueId = typeof p.issueId === "string" ? p.issueId : "";
          const timeoutMinutes =
            typeof p.timeoutMinutes === "number" && p.timeoutMinutes > 0 ? p.timeoutMinutes : 1440;
          if (!question || !target || !mode || !issueId) {
            return { error: "question, target, mode and issueId are required" };
          }
          let posted: { channel: string; ts: string };
          try {
            const channel = target.startsWith("U") ? await gateway.openDm(target) : target;
            posted = await gateway.postMessage({ channel, ...formatQuestion(question, mode) });
          } catch (err) {
            return { error: `Failed to post question to Slack: ${String(err)}` };
          }

          const key = STATE_KEYS.question(posted.channel, posted.ts);
          try {
            const pending: PendingQuestion = {
              channel: posted.channel,
              ts: posted.ts,
              issueId,
              companyId: runCtx.companyId,
              mode,
              question,
              askedAt: new Date().toISOString(),
              timeoutMinutes,
            };
            await ctx.state.set(stateScope(key), pending);
            await updateIndex(ctx, STATE_KEYS.questionIndex, (current) => [...current, key]);
          } catch (err) {
            // The question is now a live, unanswerable message in Slack: it
            // posted successfully but we failed to record enough state to
            // resolve it later. Log loudly, warn in the thread best-effort,
            // and tell the caller the truth instead of the misleading
            // "failed to post" message.
            ctx.logger.error("Failed to track ask_human question after posting to Slack", {
              err: String(err),
              channel: posted.channel,
              ts: posted.ts,
              issueId,
            });
            await gateway
              .updateMessage({
                channel: posted.channel,
                ts: posted.ts,
                text: ":warning: This question could not be tracked — please ask again.",
              })
              .catch((updateErr) => {
                ctx.logger.error("Failed to mark untracked ask_human question in Slack", {
                  err: String(updateErr),
                  channel: posted.channel,
                  ts: posted.ts,
                });
              });
            return { error: "Question was posted to Slack but could not be tracked; ask again." };
          }

          try {
            await ctx.metrics.write("slack.questions.asked", 1, { mode });
          } catch (err) {
            ctx.logger.warn("Failed to write ask_human metrics", { err: String(err) });
          }
          return {
            content: `Question posted to Slack channel ${posted.channel}. The response will be recorded as a comment on issue ${issueId}.`,
            data: { channel: posted.channel, ts: posted.ts },
          };
        },
      );
    },

    async tryHandleAnswer(msg) {
      if (!msg.threadTs || msg.threadTs === msg.ts) return false;
      const key = STATE_KEYS.question(msg.channel, msg.threadTs);
      const pending = (await ctx.state.get(stateScope(key))) as PendingQuestion | null;
      if (!pending || pending.mode !== "answer") return false;
      // This message IS an answer to a pending question — claim it before
      // any further await so a concurrent resolution for the same key
      // can't also record it. If another in-flight call already holds the
      // claim, this is still an answer (caller must not fall through to
      // chat routing), so return true without re-resolving.
      if (claimed.has(key)) return true;
      claimed.add(key);
      try {
        const name = await gateway.getUserDisplayName(msg.user);
        await resolvePending(key, pending, msg.text, name);
      } finally {
        claimed.delete(key);
      }
      return true;
    },

    async handleReaction(reaction) {
      const key = STATE_KEYS.question(reaction.channel, reaction.messageTs);
      const pending = (await ctx.state.get(stateScope(key))) as PendingQuestion | null;
      if (!pending || pending.mode !== "reaction") return;
      if (claimed.has(key)) return;
      claimed.add(key);
      try {
        const name = await gateway.getUserDisplayName(reaction.user);
        await resolvePending(key, pending, `:${reaction.reaction}:`, name);
      } finally {
        claimed.delete(key);
      }
    },
  };
}
