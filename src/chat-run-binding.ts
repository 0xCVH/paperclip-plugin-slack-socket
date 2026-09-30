// Which Slack conversation a heartbeat run is serving, plus the two small
// records record_on_issue needs to decide a thread's own issue: the reverse
// thread -> issue link and the set of agent-worded top-level posts.
//
// Why a run binding at all: the host starts a chat run with no issue in its
// context (plugin-host-services sendMessage), so its cross-issue guard
// refuses every issue write from it. record_on_issue writes through the
// plugin's own createComment path instead, which skips that guard — so the
// plugin must know, from state it wrote itself, that the calling run is one
// it started for a specific Slack thread. A run id the plugin never bound is
// refused outright.
import type { PluginContext } from "@paperclipai/plugin-sdk";
import { STATE_KEYS, stateScope } from "./constants.js";
import { linkMessage, pruneMessageLinks } from "./message-link.js";
import { updateIndex } from "./state-index.js";
import type { ChatRunBinding } from "./types.js";

/**
 * How long after the plugin's side of a turn settles the binding stays
 * live. The plugin can settle first (its turn watchdog fires) while the host
 * run is still going and may still call the tool, so settling alone must not
 * end the binding.
 */
export const CHAT_RUN_SETTLE_GRACE_MS = 30 * 60_000;
/** Hard cap on a binding's life, however the turn ended (or didn't). */
export const CHAT_RUN_MAX_AGE_MS = 24 * 3_600_000;
/**
 * How long agent-worded posts and thread -> issue links are remembered.
 * record_on_issue refuses to read a thread root older than this as linking
 * an issue, because past it the agent-post record that would have excluded
 * it may already be pruned.
 */
export const THREAD_LINK_MAX_AGE_MS = 90 * 24 * 3_600_000;

export async function bindChatRun(ctx: PluginContext, binding: ChatRunBinding): Promise<void> {
  const key = STATE_KEYS.chatRun(binding.runId);
  await ctx.state.set(stateScope(key), binding);
  await updateIndex(ctx, STATE_KEYS.chatRunIndex, (current) => (current.includes(key) ? current : [...current, key]));
}

export async function markChatRunSettled(ctx: PluginContext, runId: string, now = Date.now()): Promise<void> {
  const key = STATE_KEYS.chatRun(runId);
  const binding = (await ctx.state.get(stateScope(key))) as ChatRunBinding | null;
  if (!binding || binding.settledAt) return;
  await ctx.state.set(stateScope(key), { ...binding, settledAt: new Date(now).toISOString() });
}

export function isChatRunLive(binding: ChatRunBinding, now: number): boolean {
  if (now - Date.parse(binding.startedAt) > CHAT_RUN_MAX_AGE_MS) return false;
  if (binding.settledAt && now - Date.parse(binding.settledAt) > CHAT_RUN_SETTLE_GRACE_MS) return false;
  return true;
}

/** The run's binding, or null when there is none or it has expired. */
export async function getLiveChatRun(
  ctx: PluginContext,
  runId: string,
  now = Date.now(),
): Promise<ChatRunBinding | null> {
  const binding = (await ctx.state.get(stateScope(STATE_KEYS.chatRun(runId)))) as ChatRunBinding | null;
  if (!binding || !isChatRunLive(binding, now)) return null;
  return binding;
}

/** Remembers that `posted` is a top-level message whose words an agent chose. */
export async function recordAgentPost(ctx: PluginContext, posted: { channel: string; ts: string }): Promise<void> {
  await linkMessage(ctx, STATE_KEYS.agentPostIndex, STATE_KEYS.agentPost(posted.channel, posted.ts), posted);
}

export async function isAgentPost(ctx: PluginContext, channel: string, ts: string): Promise<boolean> {
  return (await ctx.state.get(stateScope(STATE_KEYS.agentPost(channel, ts)))) != null;
}

export interface ThreadIssueLink {
  issueId: string;
  channel: string;
  ts: string;
  createdAt: string;
}

/** Records that the thread rooted at `posted` was posted for `issueId`. */
export async function linkThreadIssue(
  ctx: PluginContext,
  posted: { channel: string; ts: string },
  issueId: string,
): Promise<void> {
  const key = STATE_KEYS.threadIssue(posted.channel, posted.ts);
  const entry: ThreadIssueLink = { issueId, channel: posted.channel, ts: posted.ts, createdAt: new Date().toISOString() };
  await ctx.state.set(stateScope(key), entry);
  await updateIndex(ctx, STATE_KEYS.threadIssueIndex, (current) => (current.includes(key) ? current : [...current, key]));
}

export async function getThreadIssue(ctx: PluginContext, channel: string, ts: string): Promise<string | null> {
  const entry = (await ctx.state.get(stateScope(STATE_KEYS.threadIssue(channel, ts)))) as ThreadIssueLink | null;
  return entry?.issueId ?? null;
}

/** Cleanup-job pass: drops expired run bindings (and their write logs) and old links. */
export async function pruneChatRunState(ctx: PluginContext, now: number): Promise<void> {
  const index = ((await ctx.state.get(stateScope(STATE_KEYS.chatRunIndex))) as string[] | null) ?? [];
  const removed: string[] = [];
  for (const key of index) {
    const binding = (await ctx.state.get(stateScope(key))) as ChatRunBinding | null;
    if (!binding) {
      removed.push(key);
      continue;
    }
    if (!isChatRunLive(binding, now)) {
      await ctx.state.delete(stateScope(key));
      await ctx.state.delete(stateScope(STATE_KEYS.chatRunWrites(binding.runId)));
      removed.push(key);
    }
  }
  await updateIndex(ctx, STATE_KEYS.chatRunIndex, (current) => current.filter((k) => !removed.includes(k)));

  await pruneMessageLinks(ctx, STATE_KEYS.agentPostIndex, THREAD_LINK_MAX_AGE_MS, now);
  await pruneMessageLinks(ctx, STATE_KEYS.threadIssueIndex, THREAD_LINK_MAX_AGE_MS, now);
}
