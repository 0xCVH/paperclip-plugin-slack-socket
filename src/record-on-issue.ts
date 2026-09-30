// record_on_issue: lets a Slack chat run write a comment onto an issue.
//
// The host refuses every issue write from a plugin-started chat run: the
// run's context carries no issue, and the cross-issue guard
// (cross-issue-influence-limit.js) throws before it even compares source and
// target. This tool writes through ctx.issues.createComment instead, which
// does not run that guard. Going around a host security control means the
// plugin must enforce the containment itself, so every rule below is part of
// the feature, not hardening: a run the plugin did not start, an issue the
// thread did not name, a 21st write — each is refused and writes nothing.
import { createHash } from "node:crypto";
import type { PluginContext, ToolRunContext } from "@paperclipai/plugin-sdk";
import { checkToolCompany } from "./access.js";
import { getLiveChatRun } from "./chat-run-binding.js";
import { RECORD_ON_ISSUE_TOOL_DECLARATION, STATE_KEYS, TOOL_NAMES, stateScope } from "./constants.js";
import { errString } from "./redact.js";
import { hasTrustPolicy, issueMatches, resolveThreadScope } from "./thread-issue.js";
import type { ChatRunBinding, RecordedWrite, SlackGateway, SlackSocketConfig } from "./types.js";

// The scope parsers live in thread-issue.ts now, shared with the mention
// relay; re-exported so callers (and the tests) keep their import path.
export { extractIssueLinkRefs, extractIssueRefs } from "./thread-issue.js";

/** Mirrors the host's CROSS_ISSUE_INFLUENCE_LIMIT, so a chat run gets no more room than an issue run. */
export const RECORD_ON_ISSUE_RUN_CAP = 20;
export const RECORD_ON_ISSUE_MAX_BODY = 8_000;

export type RecordRefusalCode =
  | "invalid_params"
  | "company_mismatch"
  | "not_a_slack_chat_run"
  | "issue_not_found"
  | "low_trust_target"
  | "issue_not_in_thread_scope"
  | "run_write_cap_exceeded"
  | "write_failed";

export type ScopeRule = "thread_linked" | "human_named";

export interface RecordOnIssueDeps {
  ctx: PluginContext;
  gateway: SlackGateway;
  getConfig: () => Promise<SlackSocketConfig>;
  now?: () => number;
}

export interface RecordOnIssue {
  registerTool(): void;
}

function hashBody(body: string): string {
  return createHash("sha256").update(body).digest("hex");
}

export function createRecordOnIssue({ ctx, gateway, getConfig, now = Date.now }: RecordOnIssueDeps): RecordOnIssue {
  // Per-run chain so the cap check, the dedupe check and the write that
  // follows them can't interleave between two overlapping calls from the
  // same run (the same idea as state-index.ts's updateIndex).
  const runChains = new Map<string, Promise<unknown>>();

  function serializeRun<T>(runId: string, fn: () => Promise<T>): Promise<T> {
    const previous = runChains.get(runId) ?? Promise.resolve();
    const next = previous.catch(() => {}).then(fn);
    runChains.set(runId, next);
    return next.finally(() => {
      if (runChains.get(runId) === next) runChains.delete(runId);
    });
  }

  return {
    registerTool() {
      ctx.tools.register(
        TOOL_NAMES.recordOnIssue,
        {
          displayName: RECORD_ON_ISSUE_TOOL_DECLARATION.displayName,
          description: RECORD_ON_ISSUE_TOOL_DECLARATION.description,
          parametersSchema: RECORD_ON_ISSUE_TOOL_DECLARATION.parametersSchema,
        },
        async (params, runCtx: ToolRunContext) => {
          const p = (params ?? {}) as Record<string, unknown>;
          const issueRef = typeof p.issue === "string" ? p.issue.trim() : "";
          const body = typeof p.body === "string" ? p.body.trim() : "";
          const wakeAssignee = p.wakeAssignee !== false;
          if (!issueRef || !body) return refuse("invalid_params", "issue and body are required.");
          if (body.length > RECORD_ON_ISSUE_MAX_BODY) {
            return refuse("invalid_params", `body is longer than ${RECORD_ON_ISSUE_MAX_BODY} characters.`);
          }

          let cfg: SlackSocketConfig;
          try {
            cfg = await getConfig();
          } catch (err) {
            return { error: `Failed to load Slack configuration: ${errString(err)}` };
          }

          // 1. Cross-tenant guard, shared with ask_human and slack_post_message.
          const companyDecision = checkToolCompany(cfg.companyId, runCtx.companyId, "Recording on an issue from Slack");
          if (!companyDecision.allowed) return refuse("company_mismatch", companyDecision.reason, runCtx);

          // 2. Only runs this plugin started for a Slack conversation. An
          // issue-bound heartbeat run has the normal API and must use it.
          let binding: ChatRunBinding | null = null;
          try {
            binding = await getLiveChatRun(ctx, runCtx.runId, now());
          } catch (err) {
            ctx.logger.warn("record_on_issue: failed to read the run binding", { err: errString(err) });
          }
          if (!binding || binding.agentId !== runCtx.agentId) {
            return refuse(
              "not_a_slack_chat_run",
              "record_on_issue only works inside a Slack conversation turn. Use the normal issue API from an issue run.",
              runCtx,
            );
          }

          // 3. The target must exist in this company. The host resolves an
          // identifier or a UUID, and requires the company to match.
          let issue: Awaited<ReturnType<PluginContext["issues"]["get"]>>;
          try {
            issue = await ctx.issues.get(issueRef, cfg.companyId);
          } catch (err) {
            ctx.logger.warn("record_on_issue: issue lookup failed", { err: errString(err) });
            issue = null;
          }
          if (!issue) return refuse("issue_not_found", `Issue "${issueRef}" was not found.`, runCtx, binding);

          // An issue under a trust preset gets its agent comments tagged and
          // quarantined by the host's own comment route (source-trust.js).
          // The plugin's createComment path can't tag, so it must not write
          // there at all rather than skip the quarantine.
          if (hasTrustPolicy((issue as { executionPolicy?: unknown }).executionPolicy)) {
            return refuse(
              "low_trust_target",
              `${issue.identifier ?? issue.id} is under a trust policy; record_on_issue can't write to it.`,
              runCtx,
              binding,
            );
          }

          // 4. The thread must name the issue (thread-issue.ts decides how,
          // the same way it does for the mention relay).
          const scope = await resolveThreadScope(
            { ctx, gateway, now },
            { channel: binding.channel, threadTs: binding.threadTs, triggerText: binding.triggerText },
            cfg,
          );
          const rule: ScopeRule | null = issueMatches(scope.linked, issue)
            ? "thread_linked"
            : issueMatches(scope.named, issue)
              ? "human_named"
              : null;
          if (!rule) {
            return refuse(
              "issue_not_in_thread_scope",
              `${issue.identifier ?? issue.id} is not this thread's issue and no person named it in this thread.`,
              runCtx,
              binding,
            );
          }

          const target = issue;
          const activeBinding = binding;
          return serializeRun(runCtx.runId, async () => {
            const writesKey = stateScope(STATE_KEYS.chatRunWrites(runCtx.runId));
            const writes = ((await ctx.state.get(writesKey)) as RecordedWrite[] | null) ?? [];
            const bodyHash = hashBody(body);

            // 6 before 5: a retry of a write that already landed returns the
            // original comment, even when that write was the run's last.
            const duplicate = writes.find((w) => w.issueId === target.id && w.bodyHash === bodyHash);
            if (duplicate) {
              return {
                content: `Already recorded on ${target.identifier ?? target.id} (comment ${duplicate.commentId}).`,
                data: {
                  ok: true,
                  duplicate: true,
                  issueId: target.id,
                  identifier: target.identifier,
                  commentId: duplicate.commentId,
                  woke: false,
                },
              };
            }
            if (writes.length >= RECORD_ON_ISSUE_RUN_CAP) {
              return refuse(
                "run_write_cap_exceeded",
                `This turn already recorded ${RECORD_ON_ISSUE_RUN_CAP} comments, the most one turn may write.`,
                runCtx,
                activeBinding,
              );
            }

            const permalink = activeBinding.threadTs
              ? await gateway.getPermalink(activeBinding.channel, activeBinding.threadTs)
              : null;
            const where = permalink ?? `Slack channel ${activeBinding.channel}`;
            const fullBody = `${body}\n\n---\nRelayed from Slack · ${where} · run \`${runCtx.runId}\``;

            let commentId: string;
            try {
              const comment = await ctx.issues.createComment(target.id, fullBody, cfg.companyId, {
                authorAgentId: runCtx.agentId,
              });
              commentId = comment.id;
            } catch (err) {
              ctx.logger.warn("record_on_issue: createComment failed", { err: errString(err), issueId: target.id });
              await writeMetric("slack.record_on_issue.refused", "write_failed");
              return { error: `Failed to write the comment: ${errString(err)}`, code: "write_failed" };
            }

            try {
              await ctx.state.set(writesKey, [...writes, { issueId: target.id, bodyHash, commentId }]);
            } catch (err) {
              // The comment is live; losing the record only weakens the
              // cap and dedupe for this run. Never report the write as failed.
              ctx.logger.warn("record_on_issue: failed to record the write for the run cap", {
                err: errString(err),
                runId: runCtx.runId,
              });
            }

            await ctx.activity
              .log({
                companyId: cfg.companyId,
                message: `Slack conversation recorded on ${target.identifier ?? target.id} by run ${runCtx.runId}`,
                entityType: "issue",
                entityId: target.id,
                metadata: {
                  action: "slack.record_on_issue",
                  identifier: target.identifier,
                  commentId,
                  channel: activeBinding.channel,
                  threadTs: activeBinding.threadTs ?? null,
                  runId: runCtx.runId,
                  scopeRule: rule,
                },
              })
              .catch((err: unknown) => ctx.logger.warn("record_on_issue: activity log failed", { err: errString(err) }));
            await writeMetric("slack.record_on_issue.written", rule);

            // 5. Best-effort wake of the assignee, never of the caller. The
            // idempotency key collapses repeat writes in one turn to one wake.
            let woke = false;
            if (wakeAssignee && target.assigneeAgentId && target.assigneeAgentId !== runCtx.agentId) {
              try {
                const result = await ctx.issues.requestWakeup(target.id, cfg.companyId, {
                  reason: "slack_record_on_issue",
                  contextSource: "slack-socket.record-on-issue",
                  idempotencyKey: `slack-record-on-issue:${runCtx.runId}:${target.id}`,
                });
                woke = Boolean(result?.queued);
              } catch (err) {
                ctx.logger.info("record_on_issue: assignee wake skipped", { err: errString(err), issueId: target.id });
              }
            }

            return {
              content: `Recorded on ${target.identifier ?? target.id} (comment ${commentId}).${woke ? " The assignee was woken." : ""}`,
              data: { ok: true, issueId: target.id, identifier: target.identifier, commentId, woke },
            };
          });
        },
      );
    },
  };

  async function refuse(
    code: RecordRefusalCode,
    message: string,
    runCtx?: ToolRunContext,
    binding?: ChatRunBinding,
  ): Promise<{ error: string; code: RecordRefusalCode }> {
    if (runCtx) {
      ctx.logger.warn("record_on_issue: refused", { code, agentId: runCtx.agentId, runId: runCtx.runId });
      if (code !== "company_mismatch") {
        // Only log into the bound company. A foreign company's refusal stays
        // in the worker log: this process must not write into that tenant.
        const cfg = await getConfig().catch(() => null);
        if (cfg?.companyId) {
          await ctx.activity
            .log({
              companyId: cfg.companyId,
              message: `record_on_issue refused (${code}) for run ${runCtx.runId}`,
              metadata: {
                action: "slack.record_on_issue.refused",
                code,
                runId: runCtx.runId,
                channel: binding?.channel ?? null,
                threadTs: binding?.threadTs ?? null,
              },
            })
            .catch(() => {});
        }
      }
    }
    await writeMetric("slack.record_on_issue.refused", code);
    return { error: message, code };
  }

  async function writeMetric(name: string, code: string): Promise<void> {
    // A `code` / scope-rule tag only: channel or thread ids would be an
    // unbounded label set (see the note in chat.ts).
    await ctx.metrics
      .write(name, 1, { code })
      .catch((err) => ctx.logger.warn("Failed to write record_on_issue metrics", { err: errString(err) }));
  }
}
