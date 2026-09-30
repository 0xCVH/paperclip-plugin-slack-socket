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
import {
  getLiveChatRun,
  getThreadIssue,
  isAgentPost,
  THREAD_LINK_MAX_AGE_MS,
} from "./chat-run-binding.js";
import { RECORD_ON_ISSUE_TOOL_DECLARATION, STATE_KEYS, THREAD_FETCH_PAGE_SIZE, TOOL_NAMES, stateScope } from "./constants.js";
import { errString } from "./redact.js";
import type { ChatRunBinding, RecordedWrite, SlackGateway, SlackSocketConfig, ThreadMessage } from "./types.js";

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

// Paperclip identifiers look like POL-3267. Matched case-insensitively
// because a person typing in Slack may write pol-3267; compared upper-cased.
const IDENTIFIER_RE = /\b([A-Za-z][A-Za-z0-9]{1,9}-\d{1,9})\b/g;
const UUID_RE = /\b([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\b/gi;
const SLACK_LINK_RE = /<(https?:\/\/[^|>\s]+)(?:\|[^>]*)?>/g;

/** Issue references (upper-cased identifiers, lower-cased UUIDs) named in free text. */
export function extractIssueRefs(text: string): Set<string> {
  const refs = new Set<string>();
  for (const m of text.matchAll(IDENTIFIER_RE)) refs.add(m[1]!.toUpperCase());
  for (const m of text.matchAll(UUID_RE)) refs.add(m[1]!.toLowerCase());
  return refs;
}

/**
 * Issue references in the links of `message` that point at this Paperclip
 * instance: `<base>/<PREFIX>/issues/<IDENT>` or `<base>/issues/<id>`. Only
 * links on the configured base URL count, so a look-alike domain links
 * nothing. Reads both `text` and the Block Kit links, because a blocks
 * message's `text` is only a fallback and often drops the URL.
 */
export function extractIssueLinkRefs(message: ThreadMessage, paperclipBaseUrl: string): Set<string> {
  const refs = new Set<string>();
  const base = paperclipBaseUrl.trim().replace(/\/+$/, "");
  if (!base) return refs;
  const urls = [...message.text.matchAll(SLACK_LINK_RE)].map((m) => m[1]!).concat(message.blockLinks ?? []);
  for (const url of urls) {
    if (!url.startsWith(`${base}/`)) continue;
    const path = url.slice(base.length).split(/[?#]/)[0]!;
    const match = /^\/(?:[A-Za-z0-9_-]+\/)?issues\/([^/]+)\/?$/.exec(path);
    if (!match) continue;
    let ref: string;
    try {
      ref = decodeURIComponent(match[1]!);
    } catch {
      continue;
    }
    for (const r of extractIssueRefs(ref)) refs.add(r);
  }
  return refs;
}

interface ThreadScope {
  linked: Set<string>;
  named: Set<string>;
}

function issueMatches(refs: Set<string>, issue: { id: string; identifier: string | null }): boolean {
  return refs.has(issue.id.toLowerCase()) || (issue.identifier !== null && refs.has(issue.identifier.toUpperCase()));
}

/** True when the issue's execution policy puts it under a trust preset or boundary. */
function hasTrustPolicy(policy: unknown): boolean {
  if (!policy || typeof policy !== "object") return false;
  return /"(trustPreset|reviewPreset|trustBoundary)"\s*:\s*(?!null)/.test(JSON.stringify(policy));
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

  /**
   * Which issues this run's thread may write to. `linked` holds the thread's
   * own issue: the plugin's thread -> issue link, or an issue link in a
   * thread root this bot posted itself — never one whose words an agent
   * chose (see STATE_KEYS.agentPost), and never an unknown-age root.
   * `named` holds issues a human named in the thread or the turn's
   * triggering message. Bot text never widens either set.
   */
  async function resolveThreadScope(binding: ChatRunBinding, cfg: SlackSocketConfig): Promise<ThreadScope> {
    const linked = new Set<string>();
    const named = extractIssueRefs(binding.triggerText);
    if (!binding.threadTs) return { linked, named };

    const linkedId = await getThreadIssue(ctx, binding.channel, binding.threadTs);
    if (linkedId) linked.add(linkedId.toLowerCase());

    let messages: ThreadMessage[] = [];
    try {
      messages = await gateway.fetchThreadReplies(binding.channel, binding.threadTs, THREAD_FETCH_PAGE_SIZE);
    } catch (err) {
      // Fail closed: without the transcript only the stored link and the
      // triggering message count.
      ctx.logger.warn("record_on_issue: thread fetch failed; scope limited to the stored link and the trigger", {
        err: errString(err),
      });
    }
    const botId = gateway.botUserId();
    for (const message of messages) {
      if (message.ts === binding.threadTs) {
        const authoredByThisBot = message.isBot && botId !== undefined && message.user === botId;
        const ageMs = now() - Number.parseFloat(message.ts) * 1000;
        if (
          authoredByThisBot &&
          Number.isFinite(ageMs) &&
          ageMs <= THREAD_LINK_MAX_AGE_MS &&
          !(await isAgentPost(ctx, binding.channel, message.ts))
        ) {
          for (const ref of extractIssueLinkRefs(message, cfg.paperclipBaseUrl)) linked.add(ref);
        }
        // A human-written root still names issues like any human message
        // below; it just never makes one "this thread's issue".
      }
      if (message.isBot || message.fromAnyBot || !message.user) continue;
      for (const ref of extractIssueRefs(message.text)) named.add(ref);
    }
    return { linked, named };
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

          // 4. The thread must name the issue.
          const scope = await resolveThreadScope(binding, cfg);
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
