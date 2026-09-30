// The mention relay: when a person @mentions the bot inside a Slack thread
// that belongs to a Paperclip issue, the plugin writes their message onto
// that issue itself — before, and independently of, the agent turn that
// answers them.
//
// Why the plugin and not the agent: a chat run the plugin starts carries no
// issue in its context, so the host's cross-issue guard refuses every issue
// write the agent attempts, and the agent's plugin tools sit behind a tool
// gateway policy that denies them by default. record_on_issue exists for the
// agent's own notes; the person's words don't need an agent at all. Writing
// them here is deterministic (no model in the path, nothing paraphrased),
// immediate (milliseconds, not a turn), and scoped by construction: the only
// possible target is the thread's own issue, decided by thread-issue.ts from
// state the plugin wrote or a root this bot posted — never from what anyone
// in the thread claims.
//
// Trust: the body is a person's unverified Slack words, quoted under a fixed
// header that names them with their unforgeable Slack id, attributed to the
// Slack agent (the plugin has no human-attribution capability). An issue
// under a trust policy is never written to, because the host's own comment
// route would tag and quarantine agent comments there and this path can't.
import type { PluginContext } from "@paperclipai/plugin-sdk";
import { RESET_KEYWORD, STATE_KEYS, stateScope } from "./constants.js";
import { errString } from "./redact.js";
import { slackTextToMarkdown } from "./slack-markdown.js";
import { updateIndex } from "./state-index.js";
import { hasTrustPolicy, resolveThreadScope, type ThreadLinkSource } from "./thread-issue.js";
import type { InboundMessage, SlackGateway, SlackSocketConfig } from "./types.js";

/** Longest message text the relay writes; the rest is cut with a marker, never refused. */
export const MENTION_RELAY_MAX_BODY = 8_000;

export type RelaySkipCode =
  | "dm"
  | "not_a_thread"
  | "empty"
  | "control_keyword"
  | "config_unavailable"
  | "no_linked_issue"
  | "ambiguous_linked_issue"
  | "issue_not_found"
  | "disabled"
  | "low_trust_target"
  | "write_failed"
  | "error";

/** The thread's issue, as the chat prompt describes it to the agent. */
export interface LinkedIssueSummary {
  id: string;
  identifier: string | null;
  title: string;
  status: string;
  assigneeAgentId: string | null;
  url: string;
  rule: ThreadLinkSource;
}

export interface RelayedComment {
  commentId: string;
  /** True when this mention had already been recorded (a redelivered event). */
  duplicate: boolean;
  /** True when the issue's assignee was woken for this write. */
  woke: boolean;
}

export interface MentionRelayOutcome {
  /** Set whenever the thread resolved to exactly one issue, written to or not. */
  issue: LinkedIssueSummary | null;
  recorded: RelayedComment | null;
  /** Why nothing was written; null when `recorded` is set. */
  skipped: RelaySkipCode | null;
}

export interface MentionRelayDeps {
  ctx: PluginContext;
  gateway: SlackGateway;
  getConfig: () => Promise<SlackSocketConfig>;
  now?: () => number;
}

export interface MentionRelay {
  /** Never throws: a relay failure is reported in the outcome, and the conversation goes on. */
  relayMention(msg: InboundMessage): Promise<MentionRelayOutcome>;
}

/** What is remembered per relayed mention. Shaped like MessageLink so pruneMessageLinks can age it out. */
export interface RelayedMentionRecord {
  channel: string;
  ts: string;
  createdAt: string;
  issueId: string;
  commentId: string;
}

type IssueRecord = NonNullable<Awaited<ReturnType<PluginContext["issues"]["get"]>>>;

/** `<base>/<PREFIX>/issues/<IDENT>` — the same shape the host's own links and paperclip-escalate use. */
export function issueUrl(paperclipBaseUrl: string, issue: { id: string; identifier: string | null }): string {
  const base = paperclipBaseUrl.trim().replace(/\/+$/, "");
  if (issue.identifier) {
    const prefix = issue.identifier.split("-", 1)[0];
    return `${base}/${prefix}/issues/${issue.identifier}`;
  }
  return `${base}/issues/${issue.id}`;
}

function slackTsToIso(ts: string): string {
  const ms = Number.parseFloat(ts) * 1000;
  return Number.isFinite(ms) ? new Date(ms).toISOString() : "unknown time";
}

function quote(text: string): string {
  return text
    .split("\n")
    .map((line) => `> ${line}`)
    .join("\n");
}

// Skips that only happen once a thread has (or should have) an issue are
// worth a metric; structural ones (a DM, a top-level mention, `reset`) are
// the normal shape of most conversations and would only be noise.
const METRIC_SKIPS: ReadonlySet<RelaySkipCode> = new Set<RelaySkipCode>([
  "ambiguous_linked_issue",
  "issue_not_found",
  "disabled",
  "low_trust_target",
  "write_failed",
  "error",
]);

export function createMentionRelay({ ctx, gateway, getConfig, now = Date.now }: MentionRelayDeps): MentionRelay {
  // The same mention arriving twice within one process (Socket Mode is
  // at-least-once) shares one outcome instead of racing two writes; the
  // persisted record below covers redelivery across restarts.
  const inFlight = new Map<string, Promise<MentionRelayOutcome>>();

  async function skip(code: RelaySkipCode, issue: LinkedIssueSummary | null = null): Promise<MentionRelayOutcome> {
    if (METRIC_SKIPS.has(code)) {
      await ctx.metrics
        .write("slack.mention_relay.skipped", 1, { code })
        .catch((err) => ctx.logger.warn("Failed to write mention relay metrics", { err: errString(err) }));
    }
    return { issue, recorded: null, skipped: code };
  }

  async function resolveLinkedIssue(
    msg: InboundMessage,
    cfg: SlackSocketConfig,
  ): Promise<{ issue: IssueRecord; rule: ThreadLinkSource } | RelaySkipCode> {
    const scope = await resolveThreadScope(
      { ctx, gateway, now },
      { channel: msg.channel, threadTs: msg.threadTs, triggerText: "" },
      cfg,
    );
    if (scope.linked.size === 0) return "no_linked_issue";

    const found = new Map<string, { issue: IssueRecord; rule: ThreadLinkSource }>();
    for (const ref of scope.linked) {
      let issue: IssueRecord | null = null;
      try {
        issue = await ctx.issues.get(ref, cfg.companyId);
      } catch (err) {
        ctx.logger.warn("mention relay: issue lookup failed", { err: errString(err) });
      }
      if (!issue) continue;
      const rule = scope.linkSources.get(ref) ?? "bot_root_link";
      const existing = found.get(issue.id);
      // The plugin's own link is the stronger claim when both name one issue.
      if (!existing || (existing.rule !== "plugin_link" && rule === "plugin_link")) found.set(issue.id, { issue, rule });
    }
    if (found.size === 0) return "issue_not_found";
    if (found.size > 1) return "ambiguous_linked_issue";
    return [...found.values()][0]!;
  }

  async function relay(msg: InboundMessage): Promise<MentionRelayOutcome> {
    if (msg.channelType === "im") return skip("dm");
    if (!msg.threadTs || msg.threadTs === msg.ts) return skip("not_a_thread");
    const text = slackTextToMarkdown(msg.text, { botUserId: gateway.botUserId() });
    if (!text) return skip("empty");
    if (text.toLowerCase() === RESET_KEYWORD) return skip("control_keyword");

    let cfg: SlackSocketConfig;
    try {
      cfg = await getConfig();
    } catch (err) {
      ctx.logger.warn("mention relay: failed to load Slack configuration", { err: errString(err) });
      return skip("config_unavailable");
    }

    const resolved = await resolveLinkedIssue(msg, cfg);
    if (typeof resolved === "string") return skip(resolved);
    const { issue, rule } = resolved;
    const summary: LinkedIssueSummary = {
      id: issue.id,
      identifier: issue.identifier,
      title: issue.title,
      status: issue.status,
      assigneeAgentId: issue.assigneeAgentId,
      url: issueUrl(cfg.paperclipBaseUrl, issue),
      rule,
    };
    const label = issue.identifier ?? issue.id;

    if (!cfg.relayMentionsToIssue) return skip("disabled", summary);
    if (hasTrustPolicy(issue.executionPolicy)) {
      ctx.logger.info("mention relay: not writing to an issue under a trust policy", { issueId: issue.id });
      return skip("low_trust_target", summary);
    }

    const recordKey = STATE_KEYS.relayedMention(msg.channel, msg.ts);
    const already = (await ctx.state.get(stateScope(recordKey))) as RelayedMentionRecord | null;
    if (already) {
      return { issue: summary, recorded: { commentId: already.commentId, duplicate: true, woke: false }, skipped: null };
    }

    const name = await gateway.getUserDisplayName(msg.user).catch(() => msg.user);
    const permalink = await gateway.getPermalink(msg.channel, msg.ts);
    const cut = text.length > MENTION_RELAY_MAX_BODY ? `${text.slice(0, MENTION_RELAY_MAX_BODY)}… [truncated]` : text;
    const origin =
      rule === "plugin_link" ? "a thread the plugin posted for this issue" : "a thread whose root links to this issue";
    const body = [
      `**Human input from Slack** — ${name} (${msg.user}), ${slackTsToIso(msg.ts)} — ${permalink ?? `Slack channel ${msg.channel}`}`,
      "",
      quote(cut),
      "",
      "---",
      `Relayed automatically by the Slack plugin from an @mention in ${origin}. These are the person's words, not the agent's.`,
    ].join("\n");

    let commentId: string;
    try {
      const comment = await ctx.issues.createComment(issue.id, body, cfg.companyId, {
        authorAgentId: cfg.defaultAgentId,
      });
      commentId = comment.id;
    } catch (err) {
      ctx.logger.warn("mention relay: createComment failed", { err: errString(err), issueId: issue.id });
      return skip("write_failed", summary);
    }

    try {
      const record: RelayedMentionRecord = {
        channel: msg.channel,
        ts: msg.ts,
        createdAt: new Date(now()).toISOString(),
        issueId: issue.id,
        commentId,
      };
      await ctx.state.set(stateScope(recordKey), record);
      await updateIndex(ctx, STATE_KEYS.relayedMentionIndex, (current) =>
        current.includes(recordKey) ? current : [...current, recordKey],
      );
    } catch (err) {
      // The comment is live; losing the record only weakens redelivery dedupe.
      ctx.logger.warn("mention relay: failed to record the relayed mention", { err: errString(err), commentId });
    }

    await ctx.activity
      .log({
        companyId: cfg.companyId,
        message: `Slack @mention by ${name} recorded on ${label}`,
        entityType: "issue",
        entityId: issue.id,
        metadata: {
          action: "slack.mention_relay",
          identifier: issue.identifier,
          commentId,
          channel: msg.channel,
          threadTs: msg.threadTs,
          ts: msg.ts,
          rule,
        },
      })
      .catch((err: unknown) => ctx.logger.warn("mention relay: activity log failed", { err: errString(err) }));
    await ctx.metrics
      .write("slack.mention_relay.written", 1, { rule })
      .catch((err) => ctx.logger.warn("Failed to write mention relay metrics", { err: errString(err) }));

    // Best-effort wake of the assignee — the person who owns the issue is the
    // one who needs to see human input — never of the Slack agent itself,
    // which is about to be woken for the reply anyway, and never for a
    // closed issue. The idempotency key collapses a redelivered mention's
    // wake to one.
    let woke = false;
    const open = issue.status !== "done" && issue.status !== "cancelled";
    if (open && issue.assigneeAgentId && issue.assigneeAgentId !== cfg.defaultAgentId) {
      try {
        const result = await ctx.issues.requestWakeup(issue.id, cfg.companyId, {
          reason: "slack_mention_relayed",
          contextSource: "slack-socket.mention-relay",
          idempotencyKey: `slack-mention-relay:${msg.channel}:${msg.ts}`,
        });
        woke = Boolean(result?.queued);
      } catch (err) {
        ctx.logger.warn("mention relay: assignee wake failed", { err: errString(err), issueId: issue.id });
      }
    }

    ctx.logger.info("mention relay: recorded a Slack @mention on an issue", { issueId: issue.id, commentId, rule, woke });
    return { issue: summary, recorded: { commentId, duplicate: false, woke }, skipped: null };
  }

  return {
    async relayMention(msg) {
      const key = `${msg.channel}:${msg.ts}`;
      const pending = inFlight.get(key);
      if (pending) return pending;
      const outcome = relay(msg)
        .catch(async (err: unknown) => {
          ctx.logger.error("mention relay failed", { err: errString(err), channel: msg.channel });
          return skip("error");
        })
        .finally(() => {
          if (inFlight.get(key) === outcome) inFlight.delete(key);
        });
      inFlight.set(key, outcome);
      return outcome;
    },
  };
}
