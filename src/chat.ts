import type { PluginContext } from "@paperclipai/plugin-sdk";
import { STATE_KEYS, stateScope } from "./constants.js";
import { markdownToMrkdwn } from "./mrkdwn.js";
import { errString } from "./redact.js";
import { describeHostError } from "./host-errors.js";
import { updateIndex } from "./state-index.js";
import type { InboundMessage, SessionEntry, SlackGateway, SlackSocketConfig } from "./types.js";

export interface ChatDeps {
  ctx: PluginContext;
  gateway: SlackGateway;
  getConfig: () => Promise<SlackSocketConfig>;
  /** Minimum ms between streaming chat.update calls. Tests pass 0. */
  updateIntervalMs?: number;
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

// Slack's chat.update rejects payloads with roughly >4000-character text.
// Stay comfortably under that for both the rolling streamed update and each
// chunk of an overlong final reply.
const MAX_MESSAGE_LENGTH = 3900;

function truncateForStreaming(text: string): string {
  return text.length > MAX_MESSAGE_LENGTH ? `${text.slice(0, MAX_MESSAGE_LENGTH)}…` : text;
}

function splitIntoChunks(text: string, size: number): string[] {
  const chunks: string[] = [];
  for (let i = 0; i < text.length; i += size) chunks.push(text.slice(i, i + size));
  return chunks;
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

// Frames a Slack turn as a conversation rather than autonomous work — see
// DEFAULT_CHAT_PROMPT_PREAMBLE in constants.ts for why this is necessary.
// When `preamble` is empty/whitespace-only, the user's text is sent
// verbatim with no framing, matching the plugin's pre-preamble behavior.
export function buildChatPrompt(preamble: string, text: string): string {
  if (!preamble.trim()) return text;
  return `${preamble}\n\nSlack message:\n${text}`;
}

export function createChat(deps: ChatDeps): Chat {
  const { ctx, gateway, getConfig } = deps;
  const updateIntervalMs = deps.updateIntervalMs ?? 1000;

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

    const clearPendingTimer = (): void => {
      if (timer) {
        clearTimeout(timer);
        timer = null;
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
        if (buffer) pushUpdate(markdownToMrkdwn(filterRuntimeNoticeLines(buffer)));
      }, updateIntervalMs);
    };

    await new Promise<void>((resolve) => {
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
              if (cfg.streamPartialReplies) scheduleUpdate();
            } else if (e.eventType === "done") {
              clearPendingTimer();
              // Convert before finalizeMessage's split/truncate so the
              // 3900-char limit is applied to the mrkdwn-converted text.
              finalizeMessage(markdownToMrkdwn(e.message ?? (buffer || "_(no reply)_")));
              resolve();
            } else if (e.eventType === "error") {
              clearPendingTimer();
              pushUpdate(`:warning: Agent error: ${e.message ?? "unknown error"}`);
              resolve();
            }
          },
        })
        .catch((err) => {
          // Clear any pending chunk-scheduled update so it can't fire later
          // and overwrite this error message with a stale partial buffer.
          clearPendingTimer();
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
      if (msg.channelType === "im") {
        await converse(msg);
        return;
      }
      if (!msg.threadTs) return;
      try {
        const entry = await ctx.state.get(stateScope(STATE_KEYS.session(msg.channel, msg.threadTs)));
        if (entry) await converse(msg);
      } catch (err) {
        ctx.logger.error("Slack handleMessage routing failed", { err: errString(err), channel: msg.channel });
      }
    },
  };
}
