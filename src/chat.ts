import type { PluginContext } from "@paperclipai/plugin-sdk";
import { REPLY_CLOSE_TAG, REPLY_OPEN_TAG, STATE_KEYS, stateScope } from "./constants.js";
import { escapeMrkdwn } from "./formatters.js";
import { markdownToMrkdwn } from "./mrkdwn.js";
import { errString } from "./redact.js";
import { describeHostError } from "./host-errors.js";
import { updateIndex } from "./state-index.js";
import type { InboundMessage, SessionEntry, SlackGateway, SlackSocketConfig } from "./types.js";
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

// Prefix on a reply that lands after the turn watchdog already gave up. By
// then the person may have mentioned the bot again, so the message has to
// say which turn it belongs to instead of arriving as a bare answer.
const LATE_REPLY_PREFIX = "⏳ _Late reply to your earlier message:_\n\n";

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

  async function getOrCreateSession(
    cfg: SlackSocketConfig,
    channel: string,
    threadTs: string,
  ): Promise<SessionEntry> {
    const key = STATE_KEYS.session(channel, threadTs);
    const inFlight = inFlightSessions.get(key);
    if (inFlight) return inFlight;

    const promise = (async (): Promise<SessionEntry> => {
      const existing = (await ctx.state.get(stateScope(key))) as SessionEntry | null;
      if (existing) {
        const updated = { ...existing, lastActivityAt: new Date().toISOString() };
        await ctx.state.set(stateScope(key), updated);
        return updated;
      }
      const session = await ctx.agents.sessions.create(cfg.defaultAgentId, cfg.companyId, {
        reason: "slack-thread",
      });
      const entry: SessionEntry = {
        sessionId: session.sessionId,
        channel,
        threadTs,
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
    threadTs: string,
    prompt: string,
  ): Promise<void> {
    const placeholder = await gateway.postMessage({ channel, threadTs, text: "_Thinking…_" });
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
    const turnTimeoutMs = turnTimeoutMsOverride ?? cfg.turnTimeoutMinutes * 60_000;

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
            await gateway.postMessage({ channel: placeholder.channel, threadTs, text: extra });
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
            await gateway.postMessage({ channel: placeholder.channel, threadTs, text: chunk });
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
          `⏳ No response from the agent after ${cfg.turnTimeoutMinutes}m — it may still be working. Mention me again to retry.`,
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
    const threadTs = msg.threadTs ?? msg.ts;
    try {
      const cfg = await getConfig();
      const text = stripMention(msg.text);
      if (!text) return;
      const prompt = buildChatPrompt(cfg.chatPromptPreamble, text);
      const entry = await getOrCreateSession(cfg, msg.channel, threadTs);
      await streamReply(cfg, entry, msg.channel, threadTs, prompt);
    } catch (err) {
      const reason = describeHostError(err);
      ctx.logger.error("Slack chat failed", { err: reason, channel: msg.channel });
      await gateway
        .postMessage({
          channel: msg.channel,
          threadTs,
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
