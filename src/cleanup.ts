import type { PluginContext } from "@paperclipai/plugin-sdk";
import { STATE_KEYS, stateScope } from "./constants.js";
import { formatQuestionExpired } from "./formatters.js";
import { errString } from "./redact.js";
import { updateIndex } from "./state-index.js";
import type { IssueThreadEntry, PendingQuestion, SessionEntry, SlackGateway, SlackSocketConfig } from "./types.js";

const ISSUE_THREAD_MAX_AGE_MS = 30 * 24 * 3_600_000; // 30 days

export async function runCleanup(
  ctx: PluginContext,
  gateway: SlackGateway,
  cfg: SlackSocketConfig,
): Promise<void> {
  const now = Date.now();

  const sessionIndex =
    ((await ctx.state.get(stateScope(STATE_KEYS.sessionIndex))) as string[] | null) ?? [];
  const removedSessions: string[] = [];
  for (const key of sessionIndex) {
    const entry = (await ctx.state.get(stateScope(key))) as SessionEntry | null;
    if (!entry) {
      removedSessions.push(key);
      continue;
    }
    const idleMs = now - Date.parse(entry.lastActivityAt);
    if (idleMs > cfg.sessionIdleHours * 3_600_000) {
      try {
        await ctx.agents.sessions.close(entry.sessionId, cfg.companyId);
      } catch (err) {
        ctx.logger.warn("Failed to close idle session", { err: errString(err), sessionId: entry.sessionId });
      }
      await ctx.state.delete(stateScope(key));
      removedSessions.push(key);
    }
  }
  await updateIndex(ctx, STATE_KEYS.sessionIndex, (current) => current.filter((k) => !removedSessions.includes(k)));

  const questionIndex =
    ((await ctx.state.get(stateScope(STATE_KEYS.questionIndex))) as string[] | null) ?? [];
  const removedQuestions: string[] = [];
  for (const key of questionIndex) {
    const pending = (await ctx.state.get(stateScope(key))) as PendingQuestion | null;
    if (!pending) {
      removedQuestions.push(key);
      continue;
    }
    const ageMs = now - Date.parse(pending.askedAt);
    if (ageMs > pending.timeoutMinutes * 60_000) {
      try {
        await ctx.issues.createComment(
          pending.issueId,
          `No Slack response to: "${pending.question}" within ${pending.timeoutMinutes} minutes.`,
          pending.companyId,
        );
        await gateway.updateMessage({
          channel: pending.channel,
          ts: pending.ts,
          ...formatQuestionExpired(pending.question),
        });
      } catch (err) {
        ctx.logger.warn("Failed to expire question", {
          err: errString(err),
          issueId: pending.issueId,
          channel: pending.channel,
          ts: pending.ts,
        });
      }
      await ctx.state.delete(stateScope(key));
      removedQuestions.push(key);
    }
  }
  await updateIndex(ctx, STATE_KEYS.questionIndex, (current) => current.filter((k) => !removedQuestions.includes(k)));

  const issueThreadIndex =
    ((await ctx.state.get(stateScope(STATE_KEYS.issueThreadIndex))) as string[] | null) ?? [];
  const removedIssueThreads: string[] = [];
  for (const key of issueThreadIndex) {
    const entry = (await ctx.state.get(stateScope(key))) as IssueThreadEntry | null;
    if (!entry) {
      removedIssueThreads.push(key);
      continue;
    }
    const ageMs = now - Date.parse(entry.createdAt);
    if (ageMs > ISSUE_THREAD_MAX_AGE_MS) {
      await ctx.state.delete(stateScope(key));
      removedIssueThreads.push(key);
    }
  }
  await updateIndex(ctx, STATE_KEYS.issueThreadIndex, (current) =>
    current.filter((k) => !removedIssueThreads.includes(k)),
  );
}
