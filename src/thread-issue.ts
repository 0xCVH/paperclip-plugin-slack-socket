// Which Paperclip issue a Slack thread is about, decided from state the
// plugin wrote itself and from a thread root this bot posted — never from
// what a person (or an agent) claims in the thread. Shared by
// record_on_issue (an agent asking to write) and the mention relay (the
// plugin writing on its own), so the two can never disagree about whose
// issue a thread is.
import type { PluginContext } from "@paperclipai/plugin-sdk";
import { getThreadIssue, isAgentPost, THREAD_LINK_MAX_AGE_MS } from "./chat-run-binding.js";
import { THREAD_FETCH_PAGE_SIZE } from "./constants.js";
import { errString } from "./redact.js";
import type { SlackGateway, SlackSocketConfig, ThreadMessage } from "./types.js";

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

/** True when the issue's execution policy puts it under a trust preset or boundary. */
export function hasTrustPolicy(policy: unknown): boolean {
  if (!policy || typeof policy !== "object") return false;
  return /"(trustPreset|reviewPreset|trustBoundary)"\s*:\s*(?!null)/.test(JSON.stringify(policy));
}

export function issueMatches(refs: Set<string>, issue: { id: string; identifier: string | null }): boolean {
  return refs.has(issue.id.toLowerCase()) || (issue.identifier !== null && refs.has(issue.identifier.toUpperCase()));
}

/** Where a thread's own issue was learned from. */
export type ThreadLinkSource = "plugin_link" | "bot_root_link";

export interface ThreadScope {
  /**
   * The thread's own issue(s): the plugin's thread -> issue link, or an
   * issue link in a thread root this bot posted itself — never one whose
   * words an agent chose (see STATE_KEYS.agentPost), and never an
   * unknown-age root.
   */
  linked: Set<string>;
  /** Which source produced each `linked` ref. */
  linkSources: Map<string, ThreadLinkSource>;
  /**
   * Issues a human named in the thread or in the turn's triggering message.
   * Bot text never widens this set.
   */
  named: Set<string>;
}

export interface ThreadScopeDeps {
  ctx: PluginContext;
  gateway: SlackGateway;
  now: () => number;
}

export interface ThreadScopeInput {
  channel: string;
  /** The thread root ts; undefined for a channel-scoped 1:1 DM, which has no thread issue. */
  threadTs?: string;
  /** The human message that started the turn; its issue references count as `named`. */
  triggerText: string;
}

export async function resolveThreadScope(
  { ctx, gateway, now }: ThreadScopeDeps,
  input: ThreadScopeInput,
  cfg: SlackSocketConfig,
): Promise<ThreadScope> {
  const linked = new Set<string>();
  const linkSources = new Map<string, ThreadLinkSource>();
  const named = extractIssueRefs(input.triggerText);
  if (!input.threadTs) return { linked, linkSources, named };

  const linkedId = await getThreadIssue(ctx, input.channel, input.threadTs);
  if (linkedId) {
    linked.add(linkedId.toLowerCase());
    linkSources.set(linkedId.toLowerCase(), "plugin_link");
  }

  let messages: ThreadMessage[] = [];
  try {
    messages = await gateway.fetchThreadReplies(input.channel, input.threadTs, THREAD_FETCH_PAGE_SIZE);
  } catch (err) {
    // Fail closed: without the transcript only the stored link and the
    // triggering message count.
    ctx.logger.warn("thread scope: thread fetch failed; scope limited to the stored link and the trigger", {
      err: errString(err),
    });
  }
  const botId = gateway.botUserId();
  for (const message of messages) {
    if (message.ts === input.threadTs) {
      const authoredByThisBot = message.isBot && botId !== undefined && message.user === botId;
      const ageMs = now() - Number.parseFloat(message.ts) * 1000;
      if (
        authoredByThisBot &&
        Number.isFinite(ageMs) &&
        ageMs <= THREAD_LINK_MAX_AGE_MS &&
        !(await isAgentPost(ctx, input.channel, message.ts))
      ) {
        for (const ref of extractIssueLinkRefs(message, cfg.paperclipBaseUrl)) {
          linked.add(ref);
          if (!linkSources.has(ref)) linkSources.set(ref, "bot_root_link");
        }
      }
      // A human-written root still names issues like any human message
      // below; it just never makes one "this thread's issue".
    }
    if (message.isBot || message.fromAnyBot || !message.user) continue;
    for (const ref of extractIssueRefs(message.text)) named.add(ref);
  }
  return { linked, linkSources, named };
}
