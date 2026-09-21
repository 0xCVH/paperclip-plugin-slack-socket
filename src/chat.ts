import type { PluginContext } from "@paperclipai/plugin-sdk";
import {
  CHANNEL_SESSION_TS,
  RESET_KEYWORD,
  STATE_KEYS,
  stateScope,
  THREAD_CONTEXT_MAX_CHARS,
  THREAD_CONTEXT_MAX_MESSAGES,
  THREAD_FETCH_PAGE_SIZE,
} from "./constants.js";
import {
  extractReply,
  extractRawStreamedTaggedReply,
  extractTaggedReply,
  filterRuntimeNoticeLines,
  HOST_WITHHELD_REPLY_NOTICE,
  reconstructStreamedAgentText,
  WITHHELD_REPLY_USER_NOTICE,
} from "./reply-extraction.js";
import {
  buildThreadContext,
  selectDeltaMessages,
  selectThreadMessages,
  THREAD_DELTA_FRAMING,
  type ThreadContextEntry,
  UNKNOWN_SPEAKER_LABEL,
} from "./thread-transcript.js";

// Compatibility re-exports: these lived in this module before the split and
// are imported from here by tests and callers. New code should import from
// the owning module.
export {
  extractReply,
  extractTaggedReply,
  filterRuntimeNoticeLines,
  HOST_WITHHELD_REPLY_NOTICE,
  reconstructStreamedAgentText,
  WITHHELD_REPLY_USER_NOTICE,
  buildThreadContext,
  selectThreadMessages,
};
export type { ThreadContextEntry };
import { escapeMrkdwn } from "./formatters.js";
import { markdownToMrkdwn } from "./mrkdwn.js";
import { errString } from "./redact.js";
import { describeHostError } from "./host-errors.js";
import { updateIndex } from "./state-index.js";
import type {
  DmSessionMode,
  InboundMessage,
  SessionEntry,
  SlackGateway,
  SlackSocketConfig,
  ThreadMessage,
} from "./types.js";
import { MAX_MESSAGE_LENGTH, splitIntoChunks } from "./slack-text.js";

export interface ChatDeps {
  ctx: PluginContext;
  gateway: SlackGateway;
  getConfig: () => Promise<SlackSocketConfig>;
  /** Minimum ms between streaming chat.update calls. Tests pass 0. */
  updateIntervalMs?: number;
  /**
   * Overrides the turn inactivity timeout, in ms. Tests pass small values so
   * they don't wait out a real timeout; production leaves it unset and the
   * duration derives from `cfg.turnTimeoutMinutes`. The notice posted on
   * expiry always names `cfg.turnTimeoutMinutes` — that is the number the
   * operator configured and the only one meaningful to a reader in Slack.
   */
  turnTimeoutMs?: number;
  /**
   * Overrides the thread-history seeding step's timeout, in ms. Tests pass
   * small values for the same reason as `turnTimeoutMs`; production leaves
   * it unset and SEED_FETCH_TIMEOUT_MS applies (see buildSeedBlock).
   */
  seedTimeoutMs?: number;
  /**
   * Overrides the placeholder heartbeat interval, in ms. Tests pass small
   * values; production leaves it unset and HEARTBEAT_INTERVAL_MS applies
   * (see the heartbeat in streamReply).
   */
  heartbeatIntervalMs?: number;
  /** Prefixes persisted session keys so two Slack apps can share a channel safely. */
  sessionKeyPrefix?: string;
}

export interface Chat {
  handleMention(msg: InboundMessage): Promise<void>;
  handleMessage(msg: InboundMessage): Promise<void>;
}

interface SessionEventLike {
  eventType: "chunk" | "status" | "done" | "error";
  stream: "stdout" | "stderr" | "system" | null;
  message: string | null;
}

function truncateForStreaming(text: string): string {
  return text.length > MAX_MESSAGE_LENGTH ? `${text.slice(0, MAX_MESSAGE_LENGTH)}…` : text;
}

// Frames a Slack turn as a conversation rather than autonomous work — see
// DEFAULT_CHAT_PROMPT_PREAMBLE in constants.ts for why this is necessary.
// When `preamble` is empty/whitespace-only, the user's text is sent
// verbatim with no framing, matching the plugin's pre-preamble behavior.
//
// `seed`, when non-empty, is a rendered <thread_context> block (see
// buildThreadContext) — untrusted text written by people who never
// addressed the bot. IMPORTANT 5: trusted framing goes on BOTH SIDES of
// that block, not just inside it. Composition is preamble, then the seed
// block, then the labelled real request:
//
//   <preamble, if any>
//
//   <thread_context>...</thread_context>
//
//   Slack message:
//   <text>
//
// `chatPromptPreamble` may be configured as "" — a supported setting — and
// without this ordering that leaves the ONE line printed INSIDE the fence
// (see THREAD_CONTEXT_FRAMING) as the only trusted framing anywhere in the
// prompt, which is exactly the line an injected message imitates. Putting
// the labelled "Slack message:" request AFTER the block, always, means the
// genuine request is never mistaken for part of the untrusted background —
// even with an empty preamble.
//
// When there is no seed at all (`seedThreadHistory: false`, or a turn with
// nothing to seed), this must stay byte-for-byte what it produced before
// seeding existed — nothing about the untrusted-block problem applies to a
// prompt that never had one.
export function buildChatPrompt(preamble: string, text: string, seed = ""): string {
  const trimmedPreamble = preamble.trim();
  if (!seed) {
    return trimmedPreamble ? `${preamble}\n\nSlack message:\n${text}` : text;
  }
  const framed = trimmedPreamble ? `${preamble}\n\n${seed}` : seed;
  return `${framed}\n\nSlack message:\n${text}`;
}

// Floor for a single chat turn's watchdog timeout. The manifest schema's
// `minimum: 1` (see manifest.ts) protects the settings form, but this plugin
// also reads `turnTimeoutMinutes` outside that form's validation (a host
// pushing config directly, or the default merge path), and this number is
// multiplied straight into a setTimeout delay below — 0, a negative value,
// or a non-number would produce a 0/NaN delay and fire the watchdog
// immediately, timing out every turn with a nonsensical "after 0m" notice.
// 1 minute is short enough to never mask a genuinely stalled turn and long
// enough that an operator's "0 means no timeout" typo can never be
// reinterpreted as "time out instantly".
export const MIN_TURN_TIMEOUT_MINUTES = 1;

// Ceiling for the same delay, needed because the floor alone leaves the
// other overflow open: setTimeout's delay is a 32-bit signed int
// (2^31-1 ms ≈ 35,791 minutes), and Node clamps anything larger to 1ms —
// so an operator typing 999999 as "effectively no timeout" would instead
// fire the watchdog INSTANTLY on every turn, with every real answer
// arriving as a late reply. 35,000 minutes (~24 days) sits comfortably
// under the overflow while being far beyond any real turn. The manifest
// schema's `maximum` mirrors this for the settings form.
export const MAX_TURN_TIMEOUT_MINUTES = 35_000;

/** Clamps a possibly-invalid `turnTimeoutMinutes` to the safe [floor, ceiling] range. */
export function clampTurnTimeoutMinutes(minutes: number): number {
  if (!Number.isFinite(minutes) || minutes < MIN_TURN_TIMEOUT_MINUTES) return MIN_TURN_TIMEOUT_MINUTES;
  return Math.min(minutes, MAX_TURN_TIMEOUT_MINUTES);
}

// Prefix on a reply that lands after the turn watchdog already gave up. By
// then the person may have mentioned the bot again, so the message has to
// say which turn it belongs to instead of arriving as a bare answer.
const LATE_REPLY_PREFIX = "⏳ _Late reply to your earlier message:_\n\n";

// How often the "_Thinking…_" placeholder is rewritten with elapsed time
// while a turn is still running (see the heartbeat in streamReply). 30s:
// frequent enough that a person watching a long turn can tell the bot is
// alive long before the turnTimeoutMinutes notice (default 10 minutes),
// infrequent enough that a whole 10-minute turn costs only ~20 chat.update
// calls — well under Slack's per-channel rate limit, and each one is
// serialized on the same update chain as every other placeholder write.
const HEARTBEAT_INTERVAL_MS = 30_000;

/** "45s" under a minute, "2m 03s" from one minute up. */
export function formatElapsed(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}m ${String(seconds).padStart(2, "0")}s`;
}

// IMPORTANT 4: bounds the whole thread-history seeding step (buildSeedBlock),
// independently of streamReply's turn watchdog, which does not arm until
// AFTER buildSeedBlock returns (see the ordering comment in converse). The
// gateway's WebClient sets clientOptions: { timeout: 10_000 } (see
// bolt-gateway.ts), but that bounds a single HTTP request, not the retries
// Slack's client wraps around one: a rate-limited conversations.replies can
// still retry for roughly ten attempts over up to ~30 minutes, and
// fetchThreadReplies can issue up to THREAD_REPLIES_MAX_PAGES (5) such
// requests sequentially, plus a users.info call per distinct speaker — all
// inside this one `await`, with nothing armed yet to rescue it and the
// person watching "_Thinking…_" the whole time.
//
// 15s: comfortably longer than one throttled WebClient call plus a retry or
// two (10s + slack), so a seeding step that is merely slow — a big thread,
// a cold connection — still gets to finish; short enough that a genuinely
// stuck call is caught and the turn moves on with no history long before
// turnTimeoutMinutes' 10-minute default would otherwise even be reached,
// let alone Slack's ~30-minute retry ceiling. Do NOT "fix" a slow seed by
// lowering the WebClient's own clientOptions.timeout instead — that bounds
// every Slack call this plugin makes, including chat.postMessage and
// chat.update on the critical path of every reply, not just this one.
const SEED_FETCH_TIMEOUT_MS = 15_000;

// Distinguishes "seeding timed out" from a genuine Slack/network failure in
// logs (see buildSeedBlock's catch), even though both are handled identically
// — log, seed nothing, let the turn continue.
class SeedTimeoutError extends Error {}

// Races `promise` against a plain timer. Deliberately does not cancel or
// otherwise stop `promise` itself — there is no AbortController plumbed
// through the gateway — so a fetch that later resolves after the timeout
// fired just resolves into a promise nothing is awaiting any more; the
// `.then`/second-arg-rejection handlers below exist so that late settlement
// can't surface as an unhandled rejection.
function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new SeedTimeoutError(`timed out after ${ms}ms`));
    }, ms);
    // Bookkeeping timer only; never let a pending 15s seed timeout hold the
    // process (or a test run) open by itself — the same guard worker.ts's
    // probeWithTimeout applies to its own race timer.
    timer.unref();
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

export interface SessionScope {
  /** Plugin-state key holding the SessionEntry for this conversation. */
  key: string;
  scope: "channel" | "thread";
  /** `undefined` means "post the reply at the top level, not in a thread". */
  replyThreadTs: string | undefined;
}

/**
 * Decides which agent session a Slack message belongs to and where its reply
 * goes. Pure — two arguments, no `ctx`, no gateway, no clock — so the whole
 * scoping rule is unit-testable without any host plumbing.
 *
 * | Input                             | Key                               | Scope   | Reply                              |
 * |------------------------------------|-----------------------------------|---------|-------------------------------------|
 * | im, mode "channel"                 | `session:<channel>:main`          | channel | top-level, or threaded if the person wrote in a thread |
 * | im, mode "thread"                  | `session:<channel>:<threadTs∥ts>` | thread  | threaded                            |
 * | any non-im channel (any mode)      | `session:<channel>:<threadTs∥ts>` | thread  | threaded                            |
 *
 * Under "channel" mode (the default), a 1:1 DM is one continuous
 * conversation, not a thread list: EVERY message in it — top-level or inside
 * any thread, including a thread that formed under the bot's own reply —
 * shares the one channel-scoped session. Reply placement still tracks where
 * the person wrote (`replyThreadTs` mirrors `msg.threadTs`), so a reply
 * never jumps out of the context they're reading; only the session identity
 * is unconditionally shared. Only "thread" mode and every non-DM surface
 * give a thread its own session — that reproduces the pre-0.10.0 behavior
 * exactly.
 */
export function resolveSessionScope(msg: InboundMessage, mode: DmSessionMode): SessionScope {
  if (msg.channelType === "im" && mode === "channel") {
    return {
      key: STATE_KEYS.session(msg.channel, CHANNEL_SESSION_TS),
      scope: "channel",
      replyThreadTs: msg.threadTs,
    };
  }
  const threadTs = msg.threadTs ?? msg.ts;
  return {
    key: STATE_KEYS.session(msg.channel, threadTs),
    scope: "thread",
    replyThreadTs: threadTs,
  };
}

/**
 * Clears the conversation stored at `key`: closes the agent session, deletes
 * the state entry, and drops the key from the session index. Returns whether
 * there was anything to clear, so callers can tell the user "reset" vs
 * "nothing to reset" truthfully.
 *
 * Lives here rather than in a new module because this is session-lifecycle
 * logic and chat.ts already owns the create/lookup half of it; `commands.ts`
 * imports it for `/paperclip reset` (no cycle — chat.ts imports nothing from
 * commands.ts).
 *
 * A failed `ctx.agents.sessions.close` still drops the local state: a stale
 * host-side session is strictly better than a Slack conversation wedged to a
 * session id the host has already forgotten. Everything else propagates, so
 * a caller never confirms a reset that did not happen.
 */
export async function resetSession(
  ctx: PluginContext,
  cfg: SlackSocketConfig,
  key: string,
  surface: "command" | "mention",
): Promise<boolean> {
  const entry = (await ctx.state.get(stateScope(key))) as SessionEntry | null;
  if (!entry) return false;
  try {
    await ctx.agents.sessions.close(entry.sessionId, cfg.companyId);
  } catch (err) {
    ctx.logger.warn("Failed to close a session during reset; dropping local state anyway", {
      err: errString(err),
      sessionId: entry.sessionId,
    });
  }
  await ctx.state.delete(stateScope(key));
  await updateIndex(ctx, STATE_KEYS.sessionIndex, (current) => current.filter((k) => k !== key));
  await ctx.metrics.write("slack.sessions.reset", 1, { surface }).catch(() => {});
  return true;
}

export function createChat(deps: ChatDeps): Chat {
  const { ctx, gateway, getConfig } = deps;
  const updateIntervalMs = deps.updateIntervalMs ?? 1000;
  const turnTimeoutMsOverride = deps.turnTimeoutMs;
  const seedTimeoutMs = deps.seedTimeoutMs ?? SEED_FETCH_TIMEOUT_MS;
  const heartbeatIntervalMs = deps.heartbeatIntervalMs ?? HEARTBEAT_INTERVAL_MS;
  const sessionKeyPrefix = deps.sessionKeyPrefix ?? "";

  const sessionScopeFor = (msg: InboundMessage, mode: DmSessionMode): SessionScope => {
    const scope = resolveSessionScope(msg, mode);
    return sessionKeyPrefix ? { ...scope, key: `${sessionKeyPrefix}${scope.key}` } : scope;
  };

  // Item 7: a process-level cache of resolved "display name (id)" labels
  // (see resolveThreadEntries), scoped to this createChat instance — i.e.
  // the plugin's whole lifetime, not one turn. Display names rarely change
  // and a busy channel mentions the same handful of people across many
  // threads, so without this a busy channel costs one users.info call per
  // distinct speaker PER THREAD — twenty threads with the same twenty
  // people is 400 calls, which can hit Slack's Tier 4 rate limit on its
  // own, and then compounds with SEED_FETCH_TIMEOUT_MS above (more calls
  // queued behind the same limit means more of them are the one that's
  // slow). Capped so a workspace with many distinct speakers over a
  // long-lived process can't grow this without bound; a plain Map eviction
  // (oldest inserted first) is enough here — this is a hit-rate
  // optimisation, not a correctness-bearing cache, so it doesn't need real
  // LRU.
  const DISPLAY_NAME_CACHE_MAX = 2000;
  const displayNameCache = new Map<string, string>();
  const cacheDisplayLabel = (userId: string, label: string): void => {
    if (displayNameCache.size >= DISPLAY_NAME_CACHE_MAX && !displayNameCache.has(userId)) {
      const oldestKey = displayNameCache.keys().next().value;
      if (oldestKey !== undefined) displayNameCache.delete(oldestKey);
    }
    displayNameCache.set(userId, label);
  };

  // Guards against two concurrent "first messages" in the same thread both
  // passing the "no existing session" check and creating duplicate sessions.
  const inFlightSessions = new Map<string, Promise<SessionEntry>>();

  // Session keys whose seed is being delivered by a turn IN THIS PROCESS
  // right now. The persisted `seedPending` flag decides across turns and
  // restarts whether a session still needs seeding; this in-memory claim
  // closes the narrow window where two overlapping turns both read
  // seedPending: true before either has cleared it (a second mention
  // arriving while the creating turn is still mid-seed) and would each
  // deliver the transcript into the one shared session. The claim is taken
  // synchronously right after getOrCreateSession resolves — before the next
  // await — so at most one concurrent turn ever wins it. Released when the
  // seeding turn finishes; a turn that failed to deliver leaves seedPending
  // true, so a later turn still retries.
  const seedInFlight = new Set<string>();

  // Same shape for delta turns: two concurrent mentions in one thread would
  // otherwise both read the same watermark and both deliver the identical
  // delta block into the one shared session. The loser simply skips the
  // fetch — its own trigger reaches the agent as its prompt regardless, and
  // whatever it did not fold into the watermark is re-fetched next turn.
  const deltaInFlight = new Set<string>();

  function stripMention(text: string): string {
    const botId = gateway.botUserId();
    return (botId ? text.replaceAll(`<@${botId}>`, "") : text).trim();
  }

  // `@paperclip reset` — exact match only, after mention-stripping, trimming
  // and lower-casing, so it can never fire on "reset the staging database".
  // Returns true when it handled the message, meaning no agent turn runs.
  async function tryHandleReset(msg: InboundMessage): Promise<boolean> {
    if (stripMention(msg.text).trim().toLowerCase() !== RESET_KEYWORD) return false;
    let cleared: boolean;
    let replyThreadTs: string | undefined;
    try {
      const cfg = await getConfig();
      const scope = sessionScopeFor(msg, cfg.dmSessionMode);
      replyThreadTs = scope.replyThreadTs;
      cleared = await resetSession(ctx, cfg, scope.key, "mention");
    } catch (err) {
      // Report failures truthfully rather than confirming a reset that did
      // not happen (the precedent at src/commands.ts:52). Only the reset
      // itself is inside this try — see below for why the confirmation post
      // must not share it.
      const reason = describeHostError(err);
      ctx.logger.error("Slack reset failed", { err: reason, channel: msg.channel });
      await gateway
        .postMessage({
          channel: msg.channel,
          threadTs: replyThreadTs ?? msg.threadTs ?? msg.ts,
          text: `:warning: Sorry — couldn't reset this conversation: ${reason.slice(0, 500)}`,
        })
        .catch(() => {});
      return true;
    }
    // The reset succeeded — the session is closed and its state gone. The
    // truthful-reporting rule cuts both ways: a failed *confirmation* post
    // must not claim the reset failed, so it gets its own catch instead of
    // falling into the ":warning: couldn't reset" branch above.
    await gateway
      .postMessage({
        channel: msg.channel,
        threadTs: replyThreadTs,
        text: cleared
          ? ":broom: Conversation reset — the next message starts fresh."
          : "Nothing to reset — this conversation is already fresh.",
      })
      .catch((err) => {
        ctx.logger.warn("Slack reset confirmation post failed (the reset itself succeeded)", {
          err: errString(err),
          channel: msg.channel,
        });
      });
    return true;
  }

  async function getOrCreateSession(
    cfg: SlackSocketConfig,
    channel: string,
    scope: SessionScope,
  ): Promise<SessionEntry> {
    const key = scope.key;
    const inFlight = inFlightSessions.get(key);
    // A caller that joins an in-flight creation gets the same entry the
    // creator built (seedPending and all). Whether either turn actually
    // seeds is decided separately, by the seedInFlight claim in converse —
    // so two racing first-mentions never both deliver the transcript.
    if (inFlight) return inFlight;

    const promise = (async (): Promise<SessionEntry> => {
      const existing = (await ctx.state.get(stateScope(key))) as SessionEntry | null;
      // Reuse-time idle check, mirroring the cleanup cron's rule exactly
      // (see cleanup.ts): an entry idle past sessionIdleHours is one the
      // operator considers closed — the cron just hasn't swept it yet. A
      // mention landing in that window must start fresh (and re-seed the
      // thread), not silently resume a conversation whose context the
      // person believes has ended. Date.parse of an unparsable timestamp
      // is NaN, and NaN comparisons are false, so a malformed entry counts
      // as NOT expired — the same conservative reading the cron applies.
      const expired =
        existing !== null &&
        Date.now() - Date.parse(existing.lastActivityAt) > cfg.sessionIdleHours * 3_600_000;
      // A Slack conversation must never keep talking to the previous agent
      // after an operator remaps the bot. Newly written entries carry their
      // agent identity, so every future remap rotates automatically. Legacy
      // entries have no identity to compare and retain the pre-existing reuse
      // behavior; operators clear those once during migration.
      const agentChanged =
        existing !== null && existing.agentId !== undefined && existing.agentId !== cfg.defaultAgentId;
      if (existing && !expired && !agentChanged) {
        // Spread preserves seedPending: a session created but not yet
        // seeded (a failed first turn) stays pending until a turn delivers.
        const updated = { ...existing, lastActivityAt: new Date().toISOString() };
        await ctx.state.set(stateScope(key), updated);
        return updated;
      }
      if (existing) {
        // A failed close still falls through to create: a stale host-side
        // session is strictly better than a wedged conversation — the same
        // trade resetSession makes.
        try {
          await ctx.agents.sessions.close(existing.sessionId, cfg.companyId);
        } catch (err) {
          ctx.logger.warn("Failed to close a replaced session at reuse time; starting fresh anyway", {
            err: errString(err),
            sessionId: existing.sessionId,
          });
        }
        await ctx.metrics
          .write(agentChanged ? "slack.sessions.agent_changed" : "slack.sessions.expired_at_reuse", 1)
          .catch(() => {});
      }
      const session = await ctx.agents.sessions.create(cfg.defaultAgentId, cfg.companyId, {
        reason: "slack-thread",
      });
      const entry: SessionEntry = {
        sessionId: session.sessionId,
        agentId: cfg.defaultAgentId,
        channel,
        // NOT a key round-trip. `scope.replyThreadTs` mirrors wherever the
        // triggering message actually landed — for a channel-scoped DM
        // (scope.scope === "channel") that's `undefined` only when the
        // message was top-level; a message that arrived inside a thread
        // (including one that formed under the bot's own reply) stores that
        // real threadTs here even though the entry lives under the shared
        // channel-scoped "…:main" key (STATE_KEYS.session(channel,
        // CHANNEL_SESSION_TS)). So `STATE_KEYS.session(channel,
        // entry.threadTs)` does NOT reliably reproduce the key this entry is
        // actually stored under — only resolveSessionScope(msg, mode) does.
        threadTs: scope.replyThreadTs ?? CHANNEL_SESSION_TS,
        // Written for potential future use; nothing reads entry.scope today.
        // Don't assume it's load-bearing — the actual scoping decision lives
        // in resolveSessionScope, not in re-deriving it from a stored entry.
        scope: scope.scope,
        lastActivityAt: new Date().toISOString(),
        // Pending until a turn actually delivers the seed (see converse).
        // Kept on the persisted entry, not derived from "is this the
        // creating turn", so a first turn that dies after this write is
        // retried rather than leaving the thread unseeded forever.
        seedPending: true,
      };
      await ctx.state.set(stateScope(key), entry);
      await updateIndex(ctx, STATE_KEYS.sessionIndex, (current) =>
        current.includes(key) ? current : [...current, key],
      );
      return entry;
    })();

    inFlightSessions.set(key, promise);
    try {
      return await promise;
    } finally {
      inFlightSessions.delete(key);
    }
  }

  // Numeric max of two Slack ts strings, either possibly undefined. Slack
  // ts values are decimal strings; comparing them as numbers is what the
  // dedup/staleness code does too. An UNPARSABLE value loses to any
  // parsable one, deliberately: the persisted watermark comes back from a
  // host-backed store this plugin does not solely control, and a corrupt
  // value must be healed by the next real ts, not returned as the max
  // forever (a NaN comparison is false both ways, which would otherwise
  // make the corrupt side sticky).
  function latestTs(a: string | undefined, b: string | undefined): string | undefined {
    const aNum = a === undefined ? NaN : Number(a);
    const bNum = b === undefined ? NaN : Number(b);
    if (Number.isNaN(aNum)) return b;
    if (Number.isNaN(bNum)) return a;
    return bNum > aNum ? b : a;
  }

  // Durably records that this session's thread history has been delivered,
  // so no later turn re-seeds it, and stamps the watermark the delivered
  // transcript covered (see SessionEntry.seededUpTo). Re-reads the current
  // entry before writing so a concurrent lastActivityAt update isn't
  // clobbered — the seedPending flip (true -> false) is idempotent and the
  // watermark merge is monotonic. `sessionId` guards identity: the key can
  // hold a DIFFERENT session by the time this write lands (a reset plus a
  // new mention during a slow turn), and stamping the replacement with the
  // old turn's bookkeeping would leave it permanently unseeded.
  async function markSeedDelivered(key: string, sessionId: string, seededUpTo: string | undefined): Promise<void> {
    const current = (await ctx.state.get(stateScope(key))) as SessionEntry | null;
    if (current && current.sessionId === sessionId && current.seedPending) {
      await ctx.state.set(stateScope(key), {
        ...current,
        seedPending: false,
        seededUpTo: latestTs(current.seededUpTo, seededUpTo),
      });
    }
  }

  // Monotonically advances the delta watermark (see SessionEntry.seededUpTo):
  // max-merge on a re-read entry, so two overlapping turns can only move it
  // forward, never back, whatever order their writes land in. Same
  // session-identity guard as markSeedDelivered, same reason.
  async function advanceWatermark(key: string, sessionId: string, ts: string | undefined): Promise<void> {
    if (ts === undefined) return;
    const current = (await ctx.state.get(stateScope(key))) as SessionEntry | null;
    if (!current || current.sessionId !== sessionId) return;
    const merged = latestTs(current.seededUpTo, ts);
    if (merged !== current.seededUpTo) {
      await ctx.state.set(stateScope(key), { ...current, seededUpTo: merged });
    }
  }

  /**
   * Turns fetched thread messages into rendering entries by resolving a
   * speaker label for each one.
   *
   * The bot's own messages are labelled exactly "you", nothing appended, so
   * the agent reads its own alert as its own words rather than as a third
   * party's claim. `isBot` alone is not enough for that — another app's
   * messages are a third party, so the id has to match this bot's.
   *
   * Every OTHER (non-bot) label carries its speaker's own Slack user id in
   * a trailing "(id)", unconditionally — a resolved display name renders as
   * "Christopher Von Hessert (U01ABC2DEF)", never bare. This is what makes
   * a bare "[you]" line provably the bot's rather than a display name that
   * merely failed to trip a content filter (see the CRITICAL, fix-round-2
   * comment above, near sanitizeLabel, for the history of why this is
   * structural rather than pattern-matched). It also gives the agent
   * something it needs anyway: a concrete id to target with ask_human or a
   * DM.
   *
   * A message with no user id at all (Slack's bot_id present but no
   * accompanying user — see ThreadMessage's isBot note in types.ts) never
   * reaches gateway.getUserDisplayName(""); it gets UNKNOWN_SPEAKER_LABEL
   * directly, with nothing appended — there is no id to append, and the
   * constant is fixed by this code, never derived from a display name, so
   * it is already, trivially, never "you".
   *
   * A speaker whose id fails to resolve isn't a special case either: the
   * raw id fills in for the missing display name, and the same
   * unconditional "(id)" still gets appended on top of that — a stable,
   * distinct label ("U-GHOST (U-GHOST)") covered by exactly the same
   * structural argument as a resolved one, not a second mechanism that
   * could itself grow a gap.
   *
   * Resolution is dedupe-then-resolve, not one id at a time (fix round 1):
   * every distinct non-bot, non-empty user id in the thread NOT ALREADY IN
   * displayNameCache is collected first, then all of them are looked up
   * CONCURRENTLY. This runs before the caller's turn watchdog has even
   * started (see buildSeedBlock / converse), so a sequential await-per-
   * speaker on a busy thread could leave a person staring at total silence
   * for as long as it takes N users.info calls to finish one after another.
   * The per-turn cache this replaces is not lost — it becomes the resolved
   * id set itself, so a speaker who wrote five times in the thread still
   * costs exactly one users.info call, just concurrently with everyone
   * else's instead of blocking them. displayNameCache (declared in
   * createChat, see its own comment) extends that dedup across turns and
   * threads for the lifetime of this process, so a speaker seen in an
   * earlier thread costs zero further calls here.
   */
  async function resolveThreadEntries(messages: ThreadMessage[]): Promise<ThreadContextEntry[]> {
    // Trust ThreadMessage.isBot, which the gateway stamped at FETCH time as
    // "this app's own bot user" (see fetchThreadReplies) — do NOT re-derive
    // it from gateway.botUserId() here. Re-reading botUserId() at resolve
    // time can disagree: worker.ts nulls the gateway proxy during every
    // config re-apply, so botUserId() briefly returns undefined mid-turn,
    // which would relabel the bot's own alert as a third party and pin it
    // into displayNameCache. isBot is the single source of truth for this.
    const isBotsOwn = (message: ThreadMessage): boolean => message.isBot;

    const idsToResolve = new Set<string>();
    for (const message of messages) {
      // Item 7: skip an id already cached from an earlier thread (see
      // displayNameCache in createChat) — no reason to call users.info
      // again for someone this process has already resolved.
      if (!isBotsOwn(message) && message.user && !displayNameCache.has(message.user)) {
        idsToResolve.add(message.user);
      }
    }

    await Promise.all(
      Array.from(idsToResolve, async (userId) => {
        // Fix 2 (residual review): a lookup failure must NOT be memoised.
        // The old code did `.catch(() => userId)` and then unconditionally
        // cached the result either way, so one transient failure (a rate
        // limit, a network blip — exactly the pressure this cache exists
        // to relieve) pinned that speaker to the raw-id fallback for the
        // rest of the process, with no retry. Only a successful lookup is
        // worth remembering across threads; a failed one isn't worth
        // failing THIS turn over, but it also isn't worth trusting for
        // every turn after it. Leaving it uncached means the id simply
        // isn't in displayNameCache below, and the map phase's own
        // fallback (see its comment) supplies the same "<id> (<id>)" shape
        // for this turn only — the next thread that sees this speaker
        // tries the lookup again instead of reusing today's failure.
        try {
          const displayName = await gateway.getUserDisplayName(userId);
          // The real BoltGateway.getUserDisplayName never rejects: on a
          // rate limit or network blip it catches internally and RESOLVES
          // the raw userId unchanged (see src/bolt-gateway.ts). So a result
          // equal to the id is not a resolved name — it is that failure
          // shape, and caching it would pin this speaker to "<id> (<id>)"
          // for the whole process, exactly the memoised-failure bug this
          // guard exists to prevent (the catch below only covers a custom
          // gateway that rejects). Either way the map phase's own fallback
          // supplies the same "<id> (<id>)" label for THIS turn, uncached,
          // so the next thread that sees this speaker tries the lookup
          // again. Structural, not a content check: every non-bot label
          // carries its own id, so no display name can produce a bare
          // "[you]" line — see the CRITICAL, fix-round-2 comment near
          // sanitizeLabel.
          if (displayName !== userId) {
            cacheDisplayLabel(userId, `${displayName} (${userId})`);
          }
        } catch {
          // Nothing to cache; the map phase below falls back to the raw
          // id for this turn.
        }
      }),
    );

    return messages.map((message) => {
      if (isBotsOwn(message)) return { label: "you", text: message.text };
      if (!message.user) return { label: UNKNOWN_SPEAKER_LABEL, text: message.text };
      // Present for every id that resolved successfully (this turn or an
      // earlier thread). Absent, by design (see Fix 2 above), for an id
      // whose lookup just failed — this fallback is exactly what supplies
      // this turn's "<id> (<id>)" label in that case, not a purely
      // defensive last resort.
      return {
        label: displayNameCache.get(message.user) ?? `${message.user} (${message.user})`,
        text: message.text,
      };
    });
  }

  /**
   * Renders the thread this message landed in as a <thread_context> block,
   * or "" when there is nothing to prepend.
   *
   * `placeholderTs` is the ts of the "_Thinking…_" message `converse` posts
   * BEFORE calling this function (see the call site) — into the SAME thread
   * this function then reads back with `fetchThreadReplies`. Slack really
   * does return it: the placeholder is posted first specifically so the
   * turn watchdog and the person both get something immediately, which
   * means by the time the fetch below runs, the thread already contains a
   * message this bot itself just posted. Without excluding it, it would be
   * labelled "[you]" — bare, the one bracket this whole format reserves as
   * provably the bot's own words (see resolveThreadEntries) — as the LAST
   * line of the transcript, ahead of the real request. `excludeTs` — see
   * selectThreadMessages — is why this is a set: both `msg.ts` (the
   * triggering mention) and `placeholderTs` are excluded the same way,
   * structurally, not by filtering on content.
   *
   * Bounded by SEED_FETCH_TIMEOUT_MS (see withTimeout below): the turn
   * watchdog does not arm until after this returns (streamReply runs next),
   * so nothing else rescues a turn stuck here.
   *
   * Never throws. A thread we cannot read — or cannot read in time — has to
   * degrade to exactly today's behavior — an answer with no history —
   * rather than escaping into converse's catch and replacing a perfectly
   * good turn with ":warning: Sorry — something went wrong". An answer
   * without context beats no answer.
   *
   * Returns `{ block, retryable }`. `retryable` is true ONLY when a fetch
   * failure or timeout means the history exists but could not be read this
   * time — the caller leaves the session's seedPending flag set so a later
   * turn tries again. It is false when there is genuinely nothing to seed
   * (not a thread, an empty thread, nothing survived selection) or the
   * block was built successfully: in all of those the seeding attempt is
   * complete and must not be retried.
   */
  async function buildSeedBlock(
    msg: InboundMessage,
    scope: SessionScope,
    placeholderTs: string,
  ): Promise<{ block: string; retryable: boolean; maxTs: string | undefined }> {
    const threadTs = scope.replyThreadTs;
    // Whether there is a thread to read is resolveSessionScope's answer, not
    // a second guess at channel types here: a channel-scoped DM session
    // (scope "channel") has no thread root at all, and a message that IS its
    // own thread root has nothing above it to fetch. A DM under
    // dmSessionMode "thread" resolves to scope "thread" and seeds like any
    // other thread. Nothing to seed, ever — not retryable.
    if (scope.scope !== "thread" || threadTs === undefined || threadTs === msg.ts) {
      return { block: "", retryable: false, maxTs: undefined };
    }
    // Exact-ts exclusions: the triggering mention (it arrives as the prompt
    // proper) and this turn's own "_Thinking…_" placeholder. A falsy ts is
    // Slack's missing-ts sentinel — dropped here so it can never become an
    // exclusion key that silently matches every fetched message whose own ts
    // also defaulted to "" (see the class filter below for the same guard on
    // the fetched side).
    const excludeTs = new Set([msg.ts, placeholderTs].filter((ts) => ts !== ""));
    const triggerTsNum = Number(msg.ts);
    try {
      const result = await withTimeout(
        (async () => {
          const fetched = await gateway.fetchThreadReplies(
            msg.channel,
            threadTs,
            // Page SIZE, not the selection cap: conversations.replies pages
            // oldest-first, so a page size equal to THREAD_CONTEXT_MAX_MESSAGES
            // would fetch only the oldest ~250 messages of a long thread and
            // drop the recent tail this feature exists to show. See
            // THREAD_FETCH_PAGE_SIZE.
            THREAD_FETCH_PAGE_SIZE,
          );
          // Watermark the whole snapshot, not just what selection keeps:
          // anything fetched now — delivered, machinery-excluded, or
          // budget-omitted (announced in-band) — is this seed's coverage,
          // and deltas start strictly after it.
          const maxTs = fetched.reduce<string | undefined>(
            (acc, m) => (m.ts !== "" ? latestTs(acc, m.ts) : acc),
            undefined,
          );
          // Drop the bot's OWN turn machinery as a class, not just this
          // turn's placeholder by its exact ts: any own-bot message posted
          // AT OR AFTER the triggering mention is a placeholder/ack/echo for
          // this turn or a racing sibling turn, never thread history — so a
          // concurrent second mention's "_Thinking…_" can't be seeded as a
          // bare "[you]" line. An own-bot message with no ts can't be
          // positioned against the trigger, so it is treated as machinery
          // too. A ts BEFORE the trigger (the genuine earlier bot alert this
          // feature exists to show) is kept.
          const history = fetched.filter((m) => {
            if (m.ts !== "" && excludeTs.has(m.ts)) return false;
            if (m.isBot) {
              if (m.ts === "") return false;
              const tsNum = Number(m.ts);
              if (Number.isFinite(tsNum) && Number.isFinite(triggerTsNum) && tsNum >= triggerTsNum) {
                return false;
              }
            }
            return true;
          });
          if (history.length === 0) {
            // Not the same as "nothing survived selection" below, which is
            // normal: an empty fetch means the parent didn't come back
            // either.
            ctx.logger.warn("Slack thread history came back empty; continuing without it", {
              channel: msg.channel,
              threadTs,
            });
            return { block: "", maxTs };
          }
          const { kept, omitted } = selectThreadMessages(
            history,
            excludeTs,
            THREAD_CONTEXT_MAX_CHARS,
            THREAD_CONTEXT_MAX_MESSAGES,
          );
          if (kept.length === 0) return { block: "", maxTs };
          return { block: buildThreadContext(await resolveThreadEntries(kept), omitted), maxTs };
        })(),
        seedTimeoutMs,
      );
      // Reached the fetch and got an answer (a block, or a considered
      // "nothing to seed") — the attempt is complete, don't retry it.
      return { ...result, retryable: false };
    } catch (err) {
      // Covers both a genuine fetch failure and SEED_FETCH_TIMEOUT_MS
      // expiring (withTimeout rejects with SeedTimeoutError in that case) —
      // deliberately the same branch, so a throttled/stuck Slack call
      // degrades exactly like any other fetch failure: log it, seed
      // nothing, let the turn continue. The history does exist but wasn't
      // read, so this IS retryable — the caller keeps seedPending set.
      ctx.logger.warn("Slack thread history fetch failed; continuing without it", {
        err: errString(err),
        channel: msg.channel,
        threadTs,
      });
      return { block: "", retryable: true, maxTs: undefined };
    }
  }

  /**
   * Renders the messages this thread gained since `watermark` as a
   * <thread_context> delta block (THREAD_DELTA_FRAMING), or "" when nothing
   * new. Returns `fetched: false` only when the thread could not be read —
   * the caller must then leave the watermark untouched so the unread gap
   * stays fetchable on a later turn. `maxTs` is the newest candidate the
   * block covers; budget-omitted candidates are announced in-band and
   * counted as covered, the same trade the initial seed's bounds make.
   *
   * The `oldest` passed to the fetch is an efficiency hint only; the strict
   * `> watermark` filter below is the correctness boundary (see the
   * SlackGateway declaration). The bot's OWN messages are excluded outright
   * — the session already contains its own words — and the trigger and this
   * turn's placeholder are excluded exactly as in buildSeedBlock. Everything
   * kept goes through the same resolveThreadEntries + buildThreadContext
   * hardening as a seed. Never throws.
   */
  async function buildDeltaBlock(
    msg: InboundMessage,
    scope: SessionScope,
    placeholderTs: string,
    watermark: string,
  ): Promise<{ block: string; fetched: boolean; maxTs: string | undefined }> {
    const threadTs = scope.replyThreadTs;
    if (scope.scope !== "thread" || threadTs === undefined || threadTs === msg.ts) {
      return { block: "", fetched: true, maxTs: undefined };
    }
    const excludeTs = new Set([msg.ts, placeholderTs].filter((ts) => ts !== ""));
    // An unparsable watermark makes every comparison below false, so the
    // delta is empty and the caller's advance to this turn's trigger
    // self-heals the corrupt value.
    const watermarkNum = Number(watermark);
    try {
      const result = await withTimeout(
        (async () => {
          const fetched = await gateway.fetchThreadReplies(msg.channel, threadTs, THREAD_FETCH_PAGE_SIZE, watermark);
          const candidates = fetched.filter(
            (m) => m.ts !== "" && Number(m.ts) > watermarkNum && !excludeTs.has(m.ts) && !m.isBot,
          );
          if (candidates.length === 0) return { block: "", maxTs: undefined };
          const maxTs = candidates.reduce<string | undefined>((acc, m) => latestTs(acc, m.ts), undefined);
          // Delta-specific selection — no message here has the seed
          // parent's privilege, and a lone oversized reply must arrive
          // truncated rather than starve the budget (see
          // selectDeltaMessages). Omitted candidates are always the oldest,
          // so the notice renders before everything kept.
          const { kept, omitted } = selectDeltaMessages(
            candidates,
            THREAD_CONTEXT_MAX_CHARS,
            THREAD_CONTEXT_MAX_MESSAGES,
          );
          if (kept.length === 0) return { block: "", maxTs };
          return {
            block: buildThreadContext(
              await resolveThreadEntries(kept),
              omitted,
              THREAD_DELTA_FRAMING,
              "before-all",
            ),
            maxTs,
          };
        })(),
        seedTimeoutMs,
      );
      return { ...result, fetched: true };
    } catch (err) {
      ctx.logger.warn("Slack thread delta fetch failed; continuing without it", {
        err: errString(err),
        channel: msg.channel,
        threadTs,
      });
      return { block: "", fetched: false, maxTs: undefined };
    }
  }

  async function streamReply(
    cfg: SlackSocketConfig,
    entry: SessionEntry,
    // `undefined` means "post at the top level" — a channel-scoped 1:1 DM.
    replyThreadTs: string | undefined,
    prompt: string,
    // Posted by the caller (converse) BEFORE any thread-history seeding, not
    // here — see the placeholder-post call in converse for why. Also the
    // source of the channel every message in this turn posts to.
    placeholder: { channel: string; ts: string },
  ): Promise<{
    /**
     * False only when the host rejected the send itself — the prompt (and
     * any seed/delta block riding in it) never reached the agent, so the
     * caller must not clear seedPending or advance the watermark. True on
     * every other outcome, including a watchdog timeout and an agent-error
     * event: the run was accepted, so the prompt was delivered.
     */
    delivered: boolean;
    /** Present when sendMessage itself rejected before the turn was accepted. */
    sendError?: unknown;
  }> {
    // Every message posted AFTER the placeholder — overflow chunks and the
    // watchdog's late reply — belongs under the reply, not beside it. In a
    // channel-scoped 1:1 DM there is no thread (`replyThreadTs` is
    // undefined), so nesting under the placeholder keeps a long or late
    // answer from spraying top-level messages down the DM. Same pattern as
    // src/post-message.ts:118.
    const followUpThreadTs = replyThreadTs ?? placeholder.ts;
    let buffer = "";
    let timer: ReturnType<typeof setTimeout> | null = null;
    let updateChain: Promise<void> = Promise.resolve();

    // --- Turn watchdog --------------------------------------------------
    // `sendMessage` resolves as soon as the host accepts the run; the
    // agent's output arrives later and asynchronously through `onEvent`. If
    // that stream stalls (host restart, dropped JSON-RPC connection) nothing
    // below ever settles: the placeholder reads "_Thinking…_" forever and
    // `converse` never returns, so the thread is wedged with no way for the
    // person or an operator to see why. `settled` is the single ownership
    // gate — whichever of timeout/done/error/rejection happens first owns
    // the placeholder, and anything arriving afterwards must leave it alone.
    let settled = false;
    let delivered = true;
    let sendError: unknown;
    // Whether the sendMessage RPC itself has settled. The watchdog firing
    // proves nothing about delivery: if the turn times out while the send
    // is STILL PENDING, the host may never have accepted the prompt, so it
    // must not be counted as delivered — the conservative direction, whose
    // only cost is a retried seed/delta the agent may already have.
    let sendSettled = false;
    let turnTimer: ReturnType<typeof setTimeout> | null = null;
    // Heartbeat: while the turn runs, the "_Thinking…_" placeholder is
    // rewritten with elapsed time ("_Thinking… (2m 03s)_") every
    // HEARTBEAT_INTERVAL_MS, so a person watching a long turn can tell the
    // bot is alive long before the watchdog notice. Skipped entirely when
    // partial replies stream — streamed content owns the placeholder then,
    // and a heartbeat overwrite would erase text the person is reading.
    // Every write goes through pushUpdate's serialized chain and checks
    // `settled` first, so a tick can never clobber the final reply, the
    // timeout notice, or an error message.
    const turnStartedAt = Date.now();
    let heartbeat: ReturnType<typeof setInterval> | null = null;
    const clearHeartbeat = (): void => {
      if (heartbeat) {
        clearInterval(heartbeat);
        heartbeat = null;
      }
    };
    // Clamped so a misconfigured (or unvalidated, host-pushed) value can
    // never produce a 0/NaN delay — see clampTurnTimeoutMinutes above. The
    // clamped value, not the raw config, is also what the timeout notice
    // below names, so the message always matches the timer that actually
    // fired.
    const turnTimeoutMinutes = clampTurnTimeoutMinutes(cfg.turnTimeoutMinutes);
    const turnTimeoutMs = turnTimeoutMsOverride ?? turnTimeoutMinutes * 60_000;

    const pushUpdate = (text: string): void => {
      const truncated = truncateForStreaming(text);
      updateChain = updateChain
        .then(() => gateway.updateMessage({ channel: placeholder.channel, ts: placeholder.ts, text: truncated }))
        .catch((err) => ctx.logger.warn("Slack chat.update failed", { err: errString(err) }));
    };

    // Final reply: update the placeholder with the first MAX_MESSAGE_LENGTH
    // chars and, if the reply is longer than that, post the remainder as
    // additional messages in the same thread rather than silently truncating.
    const finalizeMessage = (text: string): void => {
      const chunks = splitIntoChunks(text, MAX_MESSAGE_LENGTH);
      const first = chunks[0] ?? (text || "_(no reply)_");
      const rest = chunks.slice(1);
      updateChain = updateChain
        .then(() => gateway.updateMessage({ channel: placeholder.channel, ts: placeholder.ts, text: first }))
        .then(async () => {
          for (const extra of rest) {
            await gateway.postMessage({ channel: placeholder.channel, threadTs: followUpThreadTs, text: extra });
          }
        })
        .catch((err) => ctx.logger.warn("Slack chat.update failed", { err: errString(err) }));
    };

    // A reply that lands after the watchdog fired is still real work: post
    // it as a new message in the same thread rather than overwriting a
    // notice the person has already read.
    const postLateReply = (text: string): void => {
      const chunks = splitIntoChunks(`${LATE_REPLY_PREFIX}${text}`, MAX_MESSAGE_LENGTH);
      updateChain = updateChain
        .then(async () => {
          for (const chunk of chunks) {
            await gateway.postMessage({ channel: placeholder.channel, threadTs: followUpThreadTs, text: chunk });
          }
        })
        .catch((err) => ctx.logger.warn("Slack late reply post failed", { err: errString(err) }));
    };

    const clearPendingTimer = (): void => {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
    };

    const clearTurnTimer = (): void => {
      if (turnTimer) {
        clearTimeout(turnTimer);
        turnTimer = null;
      }
      // Every settle path that clears the watchdog is also done with the
      // placeholder, so the heartbeat dies with it.
      clearHeartbeat();
    };

    const scheduleUpdate = (): void => {
      if (timer) return;
      timer = setTimeout(() => {
        timer = null;
        // Convert Markdown -> Slack mrkdwn before truncation so the 3900
        // char limit applies to the text Slack will actually render. Drop
        // agent-runtime notice lines from the raw stdout being streamed —
        // see filterRuntimeNoticeLines.
        if (buffer) pushUpdate(markdownToMrkdwn(escapeMrkdwn(filterRuntimeNoticeLines(buffer))));
      }, updateIntervalMs);
    };

    await new Promise<void>((resolve) => {
      const onTurnTimeout = (): void => {
        turnTimer = null;
        if (settled) return;
        settled = true;
        if (!sendSettled) delivered = false;
        // Drop any pending debounced chunk update so it can't fire later and
        // replace the notice with a stale partial, and stop the heartbeat so
        // no elapsed-time rewrite lands after the notice.
        clearPendingTimer();
        clearHeartbeat();
        // Deliberately not phrased as a failure: the run may well still be
        // alive host-side, which is exactly why a late `done` is posted
        // rather than discarded.
        pushUpdate(
          `⏳ No response from the agent after ${turnTimeoutMinutes}m — it may still be working. Mention me again to retry.`,
        );
        // No tags: the only per-turn dimensions available here are the
        // channel and thread ids, which are unbounded and must never become
        // metric labels.
        void ctx.metrics.write("slack.turns.timedout", 1).catch(() => {});
        // Unblock converse so the turn can't wedge.
        resolve();
      };

      const resetTurnTimer = (): void => {
        if (settled) return;
        if (turnTimer) clearTimeout(turnTimer);
        turnTimer = setTimeout(onTurnTimeout, turnTimeoutMs);
      };

      resetTurnTimer();

      if (!cfg.streamPartialReplies) {
        heartbeat = setInterval(() => {
          if (settled) return;
          pushUpdate(`_Thinking… (${formatElapsed(Date.now() - turnStartedAt)})_`);
        }, heartbeatIntervalMs);
        // Bookkeeping timer only — cleared on every settle path; never let
        // it hold the process open by itself (same guard as withTimeout).
        heartbeat.unref();
      }

      ctx.agents.sessions
        .sendMessage(entry.sessionId, cfg.companyId, {
          prompt,
          // The host surfaces this as the wake `reason`. Without it the agent
          // is woken with "reason: unknown" and has to guess whether this is
          // autonomous work or a conversation turn — which pushes some agents
          // into narrating that deliberation instead of just replying.
          reason: "slack_chat_message",
          onEvent: (event) => {
            const e = event as SessionEventLike;
            // Any event at all proves the stream is alive, so every one of
            // them pushes the watchdog out — not only the ones acted on
            // below (a long run can emit nothing but `status` for minutes).
            resetTurnTimer();
            if (e.eventType === "chunk" && e.stream === "stdout" && e.message) {
              // Always accumulate: the `done` event's `message` is the SDK's
              // documented canonical final reply, but if it's ever null we
              // fall back to this buffer (see the `done` branch below).
              buffer += e.message;
              // Raw chunks are unfiltered adapter stdout with no guarantee
              // about content — they can carry agent-runtime notices and
              // even the model's internal reasoning. Only push them live to
              // Slack when the operator has explicitly opted in; the
              // default is to wait for the canonical final reply.
              // Never once the turn is settled: a late chunk must not
              // overwrite the timeout notice with a stale partial.
              if (cfg.streamPartialReplies && !settled) scheduleUpdate();
            } else if (e.eventType === "done") {
              clearPendingTimer();
              // Extract the tagged reply (see extractReply) before
              // converting/splitting, so narration outside <slack_reply>
              // tags never reaches Slack. Convert before finalizeMessage's
              // split/truncate so the 3900-char limit is applied to the
              // mrkdwn-converted text.
              // Escape before converting: escaping the agent's raw text
              // removes its ability to emit Slack control sequences
              // (<!channel>, <!here>, disguised <url|text> links) directly,
              // while the conversion still produces real link syntax from
              // the agent's own [text](url) Markdown.
              //
              // Withheld-transcript recovery: the host builds this message
              // with its BOARD comment sanitizer, which replaces the
              // agent's whole reply with HOST_WITHHELD_REPLY_NOTICE when
              // the run's text is long or opens with narration — while the
              // genuine tagged reply streamed past in the stdout chunks.
              // Recovery reads it back from there, in two tiers with
              // different trust gates:
              //
              // 1. Envelope reconstruction (reconstructStreamedAgentText):
              //    the recovered text is agent-authored by construction
              //    (only output-channel deltas contribute), so it may run
              //    for ANY host text that lost the tags — including a
              //    future rewording of the sentinel.
              // 2. Raw-buffer extraction, for adapters that stream plain
              //    text rather than envelopes: raw stdout can carry tool
              //    output, and a tag pair inside tool output (a hostile
              //    Slack message the agent read back via the API, say)
              //    must never be promoted to the bot's reply just because
              //    an ordinary untagged done message arrived. This tier is
              //    therefore gated on the exact host-authored sentinel —
              //    no thread content can steer a turn into it — and it is
              //    skipped entirely when the buffer is envelope-shaped
              //    (streamed !== null), because a literal tag pair inside
              //    an envelope's JSON is a false match whatever channel it
              //    rode in on.
              //
              // Both tiers accept only a COMPLETE last tag pair
              // (extractTaggedReply) — a truncated stream must degrade to
              // the honest notice, not post arbitrary transcript.
              const streamed = reconstructStreamedAgentText(buffer);
              const isSentinel = (e.message ?? "").trim() === HOST_WITHHELD_REPLY_NOTICE;
              const hostHasPair = e.message !== null && extractTaggedReply(e.message) !== null;
              const recovered =
                e.message !== null && !hostHasPair
                  ? streamed !== null
                    ? extractTaggedReply(streamed)
                    : isSentinel
                      ? extractRawStreamedTaggedReply(buffer)
                      : null
                  : null;
              let reply: string;
              if (recovered !== null) {
                reply = markdownToMrkdwn(escapeMrkdwn(recovered));
                void ctx.metrics.write("slack.turns.reply_recovered", 1).catch(() => {});
              } else if (isSentinel) {
                // Plugin-authored trusted text — not agent output, so it
                // skips the escaping pipeline like the timeout notice.
                reply = WITHHELD_REPLY_USER_NOTICE;
                void ctx.metrics.write("slack.turns.reply_withheld", 1).catch(() => {});
              } else {
                // Unchanged pre-recovery path, with one refinement: a null
                // done message falls back to the RECONSTRUCTED text when
                // the buffer is envelope-shaped — posting raw envelope
                // JSON was never a usable reply.
                reply = markdownToMrkdwn(
                  escapeMrkdwn(extractReply(e.message ?? ((streamed ?? "") || buffer || "_(no reply)_"))),
                );
              }
              if (settled) {
                // The watchdog already rewrote the placeholder and released
                // the turn. Post the real answer alongside it instead.
                postLateReply(reply);
                void ctx.metrics.write("slack.turns.late_reply", 1).catch(() => {});
                return;
              }
              settled = true;
              clearTurnTimer();
              finalizeMessage(reply);
              resolve();
            } else if (e.eventType === "error") {
              clearPendingTimer();
              if (settled) return;
              settled = true;
              clearTurnTimer();
              pushUpdate(`:warning: Agent error: ${e.message ?? "unknown error"}`);
              resolve();
            }
          },
        })
        .then(
          () => {
            sendSettled = true;
          },
          (err) => {
            sendSettled = true;
            sendError = err;
            // Clear any pending chunk-scheduled update so it can't fire
            // later and overwrite this error message with a stale partial
            // buffer.
            clearPendingTimer();
            // A rejection AFTER the turn already settled does not un-deliver
            // it: a done event means the run executed, so a late transport
            // failure on the request channel must not retro-flag the turn
            // (the timeout path decides its own delivered-ness above).
            if (settled) return;
            delivered = false;
            settled = true;
            clearTurnTimer();
            pushUpdate(`:warning: Failed to reach the agent: ${errString(err)}`);
            resolve();
          },
        );
    });
    await updateChain;
    return { delivered, sendError };
  }

  async function converse(msg: InboundMessage): Promise<void> {
    // Resolved inside the try, but seeded here so the catch below can still
    // reply somewhere sane when getConfig() itself rejects. A reply under
    // the user's own message is always safe to post.
    let replyThreadTs: string | undefined = msg.threadTs ?? msg.ts;
    // The "_Thinking…_" message, once posted. Held in the outer scope so the
    // catch can rewrite IT with the error rather than leaving it dangling
    // and posting a separate message beside it (see the catch).
    let placeholder: { channel: string; ts: string } | undefined;
    // The session key this turn claimed the seed for, if any — released in
    // the finally so a turn that failed to deliver leaves seedPending set
    // for a later retry.
    let claimedSeedKey: string | undefined;
    // Same lifecycle as claimedSeedKey, for the delta claim.
    let claimedDeltaKey: string | undefined;
    try {
      const cfg = await getConfig();
      const scope = sessionScopeFor(msg, cfg.dmSessionMode);
      replyThreadTs = scope.replyThreadTs;
      const text = stripMention(msg.text);
      if (!text) return;
      let entry = await getOrCreateSession(cfg, msg.channel, scope);

      // Seed decision: gated on the session's PERSISTED seedPending (so a
      // failed first turn retries — see SessionEntry.seedPending) and
      // claimed synchronously here, before the next await, so two
      // overlapping first-mentions never both deliver the transcript into
      // the one shared session (see seedInFlight).
      const wantSeed =
        cfg.seedThreadHistory && entry.seedPending === true && !seedInFlight.has(scope.key);
      if (wantSeed) {
        seedInFlight.add(scope.key);
        claimedSeedKey = scope.key;
      }

      // Posted BEFORE any thread-history fetch, not after. Seeding can cost
      // several sequential Slack API calls — paginated conversations.replies
      // plus a users.info lookup per distinct speaker — and the turn
      // watchdog does not start until streamReply runs below. Without this
      // ordering, the very first turn in a busy thread could leave a person
      // staring at total silence for as long as those calls take, with
      // nothing armed yet to rescue them (see buildSeedBlock / streamReply).
      placeholder = await gateway.postMessage({
        channel: msg.channel,
        threadTs: scope.replyThreadTs,
        text: "_Thinking…_",
      });

      // `placeholder.ts` is threaded through so buildSeedBlock can exclude
      // the placeholder message itself from the transcript it reads back —
      // see the BLOCKER 1 note on buildSeedBlock.
      let seed = "";
      let seedComplete = false;
      let seedMaxTs: string | undefined;
      if (wantSeed) {
        const result = await buildSeedBlock(msg, scope, placeholder.ts);
        seed = result.block;
        // A retryable failure (fetch error/timeout) leaves seedPending set;
        // anything else — a delivered block, or nothing to seed — completes.
        seedComplete = !result.retryable;
        seedMaxTs = result.maxTs;
      }

      // Delta hydration: on a turn whose session is already seeded, fetch
      // only what the thread gained since the watermark and prepend it the
      // same way a seed is — same fence, same hardening, refresh framing —
      // so a re-mention answers from the whole conversation, not just the
      // one line that mentioned the bot. Gated on the same seedThreadHistory
      // switch because it is the same trust boundary: text written by
      // people who never addressed the bot, in front of a tool-holding
      // agent. A session from before watermarks existed skips the fetch
      // once and starts tracking from this turn's trigger — its older
      // history was either seeded already or deliberately never delivered.
      const wantDelta =
        !wantSeed &&
        cfg.seedThreadHistory &&
        entry.seedPending !== true &&
        scope.scope === "thread" &&
        !deltaInFlight.has(scope.key);
      let delta = "";
      let deltaFetchOk = false;
      let deltaMaxTs: string | undefined;
      const initializeWatermark = wantDelta && entry.seededUpTo === undefined;
      if (wantDelta && entry.seededUpTo !== undefined) {
        // Claimed synchronously before the fetch's await, mirroring
        // seedInFlight, so a second overlapping mention skips the fetch
        // instead of double-delivering the same delta.
        deltaInFlight.add(scope.key);
        claimedDeltaKey = scope.key;
        const result = await buildDeltaBlock(msg, scope, placeholder.ts, entry.seededUpTo);
        delta = result.block;
        deltaFetchOk = result.fetched;
        deltaMaxTs = result.maxTs;
        if (delta) void ctx.metrics.write("slack.turns.thread_delta", 1).catch(() => {});
      }

      const prompt = buildChatPrompt(cfg.chatPromptPreamble, text, seed || delta);
      let { delivered, sendError } = await streamReply(cfg, entry, scope.replyThreadTs, prompt, placeholder);

      // Paperclip session registrations are process-local for some agent
      // adapters, while this plugin's session pointer is durable state. A
      // clean Paperclip restart can therefore leave a perfectly valid
      // Slack conversation pointing at a session the new host process no
      // longer knows. Heal that exact failure once, in place: drop only the
      // stale pointer, create a fresh session for the same configured agent,
      // and retry the same prompt through the existing Slack placeholder.
      // Other send failures are never retried here.
      if (!delivered && sendError && errString(sendError).includes("Session not found")) {
        const current = (await ctx.state.get(stateScope(scope.key))) as SessionEntry | null;
        if (current?.sessionId === entry.sessionId) {
          await ctx.state.delete(stateScope(scope.key));
          await updateIndex(ctx, STATE_KEYS.sessionIndex, (keys) => keys.filter((key) => key !== scope.key));
        }
        await ctx.metrics.write("slack.sessions.stale_recreated", 1).catch(() => {});
        entry = await getOrCreateSession(cfg, msg.channel, scope);
        ({ delivered, sendError } = await streamReply(cfg, entry, scope.replyThreadTs, prompt, placeholder));
      }

      // Watermark and seed bookkeeping run only after the prompt actually
      // REACHED the agent — `delivered` is false when the host rejected the
      // send, and nothing below may run then: clearing seedPending would
      // orphan a seed that was never read, and advancing the watermark
      // would permanently skip messages the agent never saw. "Seed once" is
      // thus "once delivered", not "once attempted".
      if (delivered) {
        if (wantSeed && seedComplete) {
          await markSeedDelivered(scope.key, entry.sessionId, latestTs(seedMaxTs, msg.ts));
        }
        if (wantDelta && (deltaFetchOk || initializeWatermark)) {
          // On a failed delta fetch the watermark deliberately stays put —
          // even below this turn's trigger — so the unread gap is fetched
          // by the next turn instead of being skipped forever. The cost is
          // benign: that retry re-delivers this turn's trigger as one line
          // of background, which the agent already saw as a prompt.
          await advanceWatermark(scope.key, entry.sessionId, latestTs(deltaMaxTs, msg.ts));
        }
      }
    } catch (err) {
      const reason = describeHostError(err);
      ctx.logger.error("Slack chat failed", { err: reason, channel: msg.channel });
      const text = `:warning: Sorry — something went wrong talking to the agent: ${reason.slice(0, 500)}`;
      // Surface the reason in Slack, not just in the plugin log: an operator
      // reading the thread is usually the only person who sees this, and a
      // bare "something went wrong" makes the plugin undiagnosable from the
      // outside. errString() (via describeHostError) redacts tokens. If the
      // placeholder was already posted, rewrite IT — otherwise the throw
      // (e.g. a bad preamble, or streamReply never reached) would leave
      // "_Thinking…_" in the thread forever beside this separate message.
      if (placeholder) {
        await gateway
          .updateMessage({ channel: placeholder.channel, ts: placeholder.ts, text })
          .catch(() => {});
      } else {
        await gateway
          .postMessage({ channel: msg.channel, threadTs: replyThreadTs, text })
          .catch(() => {});
      }
    } finally {
      if (claimedSeedKey) seedInFlight.delete(claimedSeedKey);
      if (claimedDeltaKey) deltaInFlight.delete(claimedDeltaKey);
    }
  }

  return {
    async handleMention(msg) {
      if (await tryHandleReset(msg)) return;
      await converse(msg);
    },
    async handleMessage(msg) {
      const botId = gateway.botUserId();
      if (botId && msg.text.includes(`<@${botId}>`)) return; // the app_mention event handles it
      if (msg.channelType === "im") {
        await converse(msg);
        return;
      }
      if (!msg.threadTs) return;
      // Access checks remain in the worker, before this handler. Only an
      // existing session for this bot/agent opts a thread into follow-ups.
      const cfg = await getConfig();
      if (!cfg.continueMentionedThreads) return;
      const scope = resolveSessionScope(msg, cfg.dmSessionMode);
      const entry = (await ctx.state.get(stateScope(scope.key))) as SessionEntry | null;
      if (!entry || entry.agentId !== cfg.defaultAgentId) return;
      const lastActivity = Date.parse(entry.lastActivityAt);
      if (!Number.isFinite(lastActivity) || Date.now() - lastActivity >= cfg.sessionIdleHours * 3_600_000) return;
      if (await tryHandleReset(msg)) return;
      await converse(msg);
    },
  };
}
