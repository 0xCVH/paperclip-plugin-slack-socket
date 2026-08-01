import type { PluginContext } from "@paperclipai/plugin-sdk";
import { ASK_HUMAN_TOOL_DECLARATION, STATE_KEYS, TOOL_NAMES, stateScope } from "./constants.js";
import { formatQuestion, formatQuestionResolved } from "./formatters.js";
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
    const index = ((await ctx.state.get(stateScope(STATE_KEYS.questionIndex))) as string[] | null) ?? [];
    await ctx.state.set(stateScope(STATE_KEYS.questionIndex), index.filter((k) => k !== key));
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
          try {
            const channel = target.startsWith("U") ? await gateway.openDm(target) : target;
            const posted = await gateway.postMessage({ channel, ...formatQuestion(question, mode) });
            const key = STATE_KEYS.question(posted.channel, posted.ts);
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
            const index =
              ((await ctx.state.get(stateScope(STATE_KEYS.questionIndex))) as string[] | null) ?? [];
            await ctx.state.set(stateScope(STATE_KEYS.questionIndex), [...index, key]);
            await ctx.metrics.write("slack.questions.asked", 1, { mode });
            return {
              content: `Question posted to Slack channel ${posted.channel}. The response will be recorded as a comment on issue ${issueId}.`,
              data: { channel: posted.channel, ts: posted.ts },
            };
          } catch (err) {
            return { error: `Failed to post question to Slack: ${String(err)}` };
          }
        },
      );
    },

    async tryHandleAnswer(msg) {
      if (!msg.threadTs || msg.threadTs === msg.ts) return false;
      const key = STATE_KEYS.question(msg.channel, msg.threadTs);
      const pending = (await ctx.state.get(stateScope(key))) as PendingQuestion | null;
      if (!pending || pending.mode !== "answer") return false;
      const name = await gateway.getUserDisplayName(msg.user);
      await resolvePending(key, pending, msg.text, name);
      return true;
    },

    async handleReaction(reaction) {
      const key = STATE_KEYS.question(reaction.channel, reaction.messageTs);
      const pending = (await ctx.state.get(stateScope(key))) as PendingQuestion | null;
      if (!pending || pending.mode !== "reaction") return;
      const name = await gateway.getUserDisplayName(reaction.user);
      await resolvePending(key, pending, `:${reaction.reaction}:`, name);
    },
  };
}
