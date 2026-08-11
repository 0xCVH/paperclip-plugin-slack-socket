import type { PluginContext } from "@paperclipai/plugin-sdk";
import {
  CHANNEL_SESSION_TS,
  REPLY_CLOSE_TAG,
  REPLY_OPEN_TAG,
  RESET_KEYWORD,
  STATE_KEYS,
  stateScope,
} from "./constants.js";
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

// Raw adapter stdout (streamed only when streamPartialReplies is enabled)
// can carry agent-runtime housekeeping lines like:
//   [paperclip] ACPX session "acpx:v2:…" does not match the current
//   agent/cwd/mode/runtime identity; starting fresh in "…"
// These aren't part of the reply and shouldn't show up in a Slack thread.
// This does NOT and cannot filter model chain-of-thought/reasoning that may
// also be present in raw stdout — that's exactly why final-reply-only is the
// default and streaming is an explicit opt-in.
const RUNTIME_NOTICE_LINE = /^\s*\[paperclip\]\s/;

export function filterRuntimeNoticeLines(text: string): string {
  return text
    .split("\n")
    .filter((line) => !RUNTIME_NOTICE_LINE.test(line))
    .join("\n");
}

// Pulls the agent's actual reply out of the <slack_reply>/</slack_reply>
// tags requested by DEFAULT_CHAT_PROMPT_PREAMBLE. A prompt instruction not
// to narrate isn't enough on its own — some adapters narrate *about* the
// instruction ("The key instruction is: '...' So I should just respond
// naturally.") and then jam the real answer directly onto the end with no
// separator, which makes line/paragraph heuristics unsafe. An explicit
// delimiter sidesteps that entirely: we don't guess where narration ends,
// we look for the marker the agent was told to use.
//
// - If one or more complete tag pairs are present, the LAST one wins (a
//   model may echo the instruction, tags and all, before its real reply).
// - If there's an opening tag with no matching close, everything after the
//   LAST opening tag is used (the agent started the tag but got cut off,
//   or streaming truncated the close).
// - Otherwise (no tags at all), the input is returned unchanged — this is
//   the fallback for agents/adapters that don't follow the tag instruction,
//   and it preserves the plugin's pre-0.6.0 behavior exactly.
// - If the extracted content would be empty, that's not a usable reply, so
//   fall back to the input unchanged rather than posting nothing.
export function extractReply(text: string): string {
  const closeIdx = text.lastIndexOf(REPLY_CLOSE_TAG);
  if (closeIdx !== -1) {
    const openIdx = text.lastIndexOf(REPLY_OPEN_TAG, closeIdx);
    if (openIdx !== -1) {
      const content = text.slice(openIdx + REPLY_OPEN_TAG.length, closeIdx).trim();
      if (content) return content;
      return text.trim();
    }
  }

  const openIdx = text.lastIndexOf(REPLY_OPEN_TAG);
  if (openIdx !== -1) {
    const content = text.slice(openIdx + REPLY_OPEN_TAG.length).trim();
    if (content) return content;
    return text.trim();
  }

  return text.trim();
}

// Frames a Slack turn as a conversation rather than autonomous work — see
// DEFAULT_CHAT_PROMPT_PREAMBLE in constants.ts for why this is necessary.
// When `preamble` is empty/whitespace-only, the user's text is sent
// verbatim with no framing, matching the plugin's pre-preamble behavior.
export function buildChatPrompt(preamble: string, text: string): string {
  if (!preamble.trim()) return text;
  return `${preamble}\n\nSlack message:\n${text}`;
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

  // Guards against two concurrent "first messages" in the same thread both
  // passing the "no existing session" check and creating duplicate sessions.
  const inFlightSessions = new Map<string, Promise<SessionEntry>>();

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
      const scope = resolveSessionScope(msg, cfg.dmSessionMode);
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
    if (inFlight) return inFlight;

    const promise = (async (): Promise<SessionEntry> => {
      const existing = (await ctx.state.get(stateScope(key))) as SessionEntry | null;
      if (existing) {
        const updated = { ...existing, lastActivityAt: new Date().toISOString() };
        await ctx.state.set(stateScope(key), updated);
        return updated;
      }
      const created = await ctx.agents.sessions.create(cfg.defaultAgentId, cfg.companyId, {
        reason: "slack-thread",
      });
      const entry: SessionEntry = {
        sessionId: created.sessionId,
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

  async function streamReply(
    cfg: SlackSocketConfig,
    entry: SessionEntry,
    channel: string,
    // `undefined` means "post at the top level" — a channel-scoped 1:1 DM.
    replyThreadTs: string | undefined,
    prompt: string,
  ): Promise<void> {
    const placeholder = await gateway.postMessage({ channel, threadTs: replyThreadTs, text: "_Thinking…_" });
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
    let turnTimer: ReturnType<typeof setTimeout> | null = null;
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
        // Drop any pending debounced chunk update so it can't fire later and
        // replace the notice with a stale partial.
        clearPendingTimer();
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
              const reply = markdownToMrkdwn(
                escapeMrkdwn(extractReply(e.message ?? (buffer || "_(no reply)_"))),
              );
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
        .catch((err) => {
          // Clear any pending chunk-scheduled update so it can't fire later
          // and overwrite this error message with a stale partial buffer.
          clearPendingTimer();
          if (settled) return;
          settled = true;
          clearTurnTimer();
          pushUpdate(`:warning: Failed to reach the agent: ${errString(err)}`);
          resolve();
        });
    });
    await updateChain;
  }

  async function converse(msg: InboundMessage): Promise<void> {
    // Resolved inside the try, but seeded here so the catch below can still
    // reply somewhere sane when getConfig() itself rejects. A reply under
    // the user's own message is always safe to post.
    let replyThreadTs: string | undefined = msg.threadTs ?? msg.ts;
    try {
      const cfg = await getConfig();
      const scope = resolveSessionScope(msg, cfg.dmSessionMode);
      replyThreadTs = scope.replyThreadTs;
      const text = stripMention(msg.text);
      if (!text) return;
      const prompt = buildChatPrompt(cfg.chatPromptPreamble, text);
      const entry = await getOrCreateSession(cfg, msg.channel, scope);
      await streamReply(cfg, entry, msg.channel, scope.replyThreadTs, prompt);
    } catch (err) {
      const reason = describeHostError(err);
      ctx.logger.error("Slack chat failed", { err: reason, channel: msg.channel });
      await gateway
        .postMessage({
          channel: msg.channel,
          threadTs: replyThreadTs,
          // Surface the reason in Slack, not just in the plugin log: an
          // operator reading the thread is usually the only person who sees
          // this, and a bare "something went wrong" makes the plugin
          // undiagnosable from the outside. errString() redacts tokens.
          text: `:warning: Sorry — something went wrong talking to the agent: ${reason.slice(0, 500)}`,
        })
        .catch(() => {});
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
      if (msg.channelType === "im") await converse(msg);
      // Channels, private channels and group DMs: only an explicit @mention
      // (delivered as app_mention, handled above) starts or continues a
      // conversation. A thread reply is not addressed to the bot just
      // because the bot is in the thread — an agent that posts proactively
      // would otherwise turn every human follow-up under its own message
      // into an agent turn, including replies people meant for each other.
      // Mentioning the bot again in the same thread reuses that thread's
      // session (see getOrCreateSession), so continuity is not lost.
    },
  };
}
