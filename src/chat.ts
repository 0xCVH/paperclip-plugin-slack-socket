import type { PluginContext } from "@paperclipai/plugin-sdk";
import { STATE_KEYS, stateScope } from "./constants.js";
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
      updateChain = updateChain
        .then(() => gateway.updateMessage({ channel: placeholder.channel, ts: placeholder.ts, text }))
        .catch((err) => ctx.logger.warn("Slack chat.update failed", { err: String(err) }));
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
        if (buffer) pushUpdate(buffer);
      }, updateIntervalMs);
    };

    await new Promise<void>((resolve) => {
      ctx.agents.sessions
        .sendMessage(entry.sessionId, cfg.companyId, {
          prompt,
          onEvent: (event) => {
            const e = event as SessionEventLike;
            if (e.eventType === "chunk" && e.stream === "stdout" && e.message) {
              buffer += e.message;
              scheduleUpdate();
            } else if (e.eventType === "done") {
              clearPendingTimer();
              pushUpdate(e.message ?? (buffer || "_(no reply)_"));
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
          pushUpdate(`:warning: Failed to reach the agent: ${String(err)}`);
          resolve();
        });
    });
    await updateChain;
  }

  async function converse(msg: InboundMessage): Promise<void> {
    const threadTs = msg.threadTs ?? msg.ts;
    try {
      const cfg = await getConfig();
      const prompt = stripMention(msg.text);
      if (!prompt) return;
      const entry = await getOrCreateSession(cfg, msg.channel, threadTs);
      await streamReply(cfg, entry, msg.channel, threadTs, prompt);
    } catch (err) {
      ctx.logger.error("Slack chat failed", { err: String(err), channel: msg.channel });
      await gateway
        .postMessage({
          channel: msg.channel,
          threadTs,
          text: ":warning: Sorry — something went wrong talking to the agent. Please try again.",
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
        ctx.logger.error("Slack handleMessage routing failed", { err: String(err), channel: msg.channel });
      }
    },
  };
}
