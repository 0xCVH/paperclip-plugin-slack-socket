import boltPkg from "@slack/bolt";
import { errString } from "./redact.js";
import { isDmChannelId } from "./slack-ids.js";
import type {
  InboundAction,
  InboundCommand,
  InboundMessage,
  InboundReaction,
  OutboundMessage,
  SlackGateway,
  ThreadMessage,
} from "./types.js";

const { App } = boltPkg;

// Slack stamps a subtype on some genuinely human messages. `thread_broadcast`
// is a thread reply the author also sent to the channel; `file_share` is a
// message carrying an attachment, and it still holds whatever the human typed
// alongside the file. Both must reach chat routing like any other message.
// Every other subtype (message_changed, message_deleted, channel_join,
// bot_message, …) is not a live human message and stays filtered.
const PASSTHROUGH_SUBTYPES = new Set(["thread_broadcast", "file_share"]);

// conversations.replies returns the parent plus one page of replies per
// call. Paging past the first page is bounded by a hard request count, not
// just Slack's has_more/next_cursor signals, so a runaway thread (or a
// pathological cursor loop) cannot hang a turn indefinitely.
const THREAD_REPLIES_MAX_PAGES = 5;

/**
 * True when an inbound Slack message event is a live human message that chat
 * routing should see. Pure and exported so the filter is testable without
 * standing up a Bolt app.
 */
export function shouldDispatchMessage(m: { subtype?: string; bot_id?: string; user?: string }): boolean {
  if (m.subtype && !PASSTHROUGH_SUBTYPES.has(m.subtype)) return false;
  if (m.bot_id) return false;
  if (!m.user) return false;
  return true;
}

interface GatewayLogger {
  warn(message: string, data?: Record<string, unknown>): void;
}

export class BoltGateway implements SlackGateway {
  private readonly app: InstanceType<typeof App>;
  private readonly logger: GatewayLogger;
  private connected = false;
  private botId: string | undefined;
  private messageHandlers: Array<(msg: InboundMessage) => Promise<void>> = [];
  private mentionHandlers: Array<(msg: InboundMessage) => Promise<void>> = [];
  private reactionHandlers: Array<(r: InboundReaction) => Promise<void>> = [];

  constructor(opts: { botToken: string; appToken: string; logger: GatewayLogger }) {
    this.logger = opts.logger;
    this.app = new App({
      token: opts.botToken,
      appToken: opts.appToken,
      socketMode: true,
      // Defense in depth, not a substitute for the socket watchdog's own
      // bound (see probeWithTimeout in worker.ts): with no clientOptions at
      // all, the underlying WebClient uses timeout: 0 (no per-request abort)
      // plus Slack's default ~10-retries-over-~30-minutes policy, so any
      // call through `this.app.client` — including the `auth.test()` used by
      // both `start()` and `probe()` — could otherwise hang far longer than
      // this plugin's 60s watchdog tick interval.
      clientOptions: { timeout: 10_000 },
    });

    this.app.event("app_mention", async ({ event }) => {
      const e = event as { channel: string; user?: string; text?: string; ts: string; thread_ts?: string };
      await this.dispatch(this.mentionHandlers, {
        channel: e.channel,
        // Unlike `message`, app_mention carries no channel_type field, so
        // the conversation kind has to be inferred from the id shape (see
        // isDmChannelId). Slack fires app_mention inside 1:1 DMs too — a
        // hardcoded "channel" here made "@bot hi" in a DM start a fresh,
        // thread-scoped session while a plain "hi" in the same DM kept the
        // remembered channel-scoped one.
        channelType: isDmChannelId(e.channel) ? "im" : "channel",
        user: e.user ?? "",
        text: e.text ?? "",
        ts: e.ts,
        threadTs: e.thread_ts,
      });
    });

    this.app.message(async ({ message }) => {
      const m = message as {
        subtype?: string; bot_id?: string; channel: string; channel_type?: string;
        user?: string; text?: string; ts: string; thread_ts?: string;
      };
      if (!shouldDispatchMessage(m)) return;
      const channelType = m.channel_type === "im" ? "im" : m.channel_type === "group" ? "group" : "channel";
      await this.dispatch(this.messageHandlers, {
        channel: m.channel,
        channelType,
        // shouldDispatchMessage already rejected a missing user; the `?? ""`
        // only restores the narrowing TypeScript loses across the call, and
        // matches the app_mention handler above.
        user: m.user ?? "",
        text: m.text ?? "",
        ts: m.ts,
        threadTs: m.thread_ts,
      });
    });

    this.app.event("reaction_added", async ({ event }) => {
      const e = event as { user: string; reaction: string; item: { type: string; channel?: string; ts?: string } };
      if (e.item.type !== "message" || !e.item.channel || !e.item.ts) return;
      await this.dispatch(this.reactionHandlers, {
        channel: e.item.channel,
        messageTs: e.item.ts,
        user: e.user,
        reaction: e.reaction,
      });
    });
  }

  private async dispatch<T>(handlers: Array<(payload: T) => Promise<void>>, payload: T): Promise<void> {
    for (const handler of handlers) {
      try {
        await handler(payload);
      } catch (err) {
        this.logger.warn("Slack handler failed", { err: errString(err) });
      }
    }
  }

  onMessage(handler: (msg: InboundMessage) => Promise<void>): void { this.messageHandlers.push(handler); }
  onMention(handler: (msg: InboundMessage) => Promise<void>): void { this.mentionHandlers.push(handler); }
  onReaction(handler: (r: InboundReaction) => Promise<void>): void { this.reactionHandlers.push(handler); }

  onAction(pattern: RegExp, handler: (action: InboundAction) => Promise<void>): void {
    this.app.action(pattern, async ({ ack, body, action }) => {
      await ack();
      const b = body as {
        user?: { id?: string; name?: string; username?: string };
        channel?: { id?: string };
        message?: { ts?: string };
      };
      const a = action as { action_id?: string; value?: string };
      try {
        await handler({
          actionId: a.action_id ?? "",
          value: a.value ?? "",
          user: b.user?.id ?? "",
          userName: b.user?.name ?? b.user?.username ?? b.user?.id ?? "unknown",
          channel: b.channel?.id ?? "",
          messageTs: b.message?.ts ?? "",
        });
      } catch (err) {
        this.logger.warn("Slack action handler failed", { err: errString(err) });
      }
    });
  }

  onCommand(command: string, handler: (cmd: InboundCommand) => Promise<void>): void {
    this.app.command(command, async ({ ack, command: cmd }) => {
      await ack();
      try {
        await handler({ command: cmd.command, text: cmd.text ?? "", user: cmd.user_id, channel: cmd.channel_id });
      } catch (err) {
        this.logger.warn("Slack command handler failed", { err: errString(err) });
      }
    });
  }

  async start(): Promise<void> {
    // Verify the bot token (and capture the bot's user id) before opening
    // the socket at all. auth.test is a plain HTTP call against
    // `this.app.client`, which doesn't require the socket to be started.
    // Doing this first means a bad token fails fast with no socket to unwind.
    const auth = await this.app.client.auth.test();
    this.botId = (auth as { user_id?: string }).user_id;

    const receiver = (this.app as unknown as {
      receiver?: { client?: { on?: (event: string, fn: () => void) => void } };
    }).receiver;
    receiver?.client?.on?.("connected", () => { this.connected = true; });
    receiver?.client?.on?.("disconnected", () => { this.connected = false; });

    await this.app.start();
    this.connected = true;
  }

  async stop(): Promise<void> {
    await this.app.stop();
    this.connected = false;
  }

  isConnected(): boolean { return this.connected; }
  botUserId(): string | undefined { return this.botId; }

  async probe(): Promise<boolean> {
    // Plain HTTP against the same client `start()` uses, so it does not need
    // the socket to be up. Any failure at all — network, revoked token,
    // rotated token — reads as "not alive"; the watchdog's job is to re-apply
    // the config, which re-resolves both secret refs.
    try {
      const auth = await this.app.client.auth.test();
      return auth.ok === true;
    } catch {
      return false;
    }
  }

  async postMessage(msg: OutboundMessage): Promise<{ channel: string; ts: string }> {
    const res = await this.app.client.chat.postMessage({
      channel: msg.channel,
      text: msg.text,
      blocks: msg.blocks as never,
      thread_ts: msg.threadTs,
    });
    return { channel: (res.channel as string) ?? msg.channel, ts: (res.ts as string) ?? "" };
  }

  async updateMessage(msg: { channel: string; ts: string; text: string; blocks?: unknown[] }): Promise<void> {
    await this.app.client.chat.update({
      channel: msg.channel,
      ts: msg.ts,
      text: msg.text,
      blocks: (msg.blocks ?? []) as never,
    });
  }

  async postEphemeral(msg: { channel: string; user: string; text: string }): Promise<void> {
    await this.app.client.chat.postEphemeral({ channel: msg.channel, user: msg.user, text: msg.text });
  }

  async openDm(userId: string): Promise<string> {
    const res = await this.app.client.conversations.open({ users: userId });
    return (res.channel as { id?: string })?.id ?? userId;
  }

  /**
   * Reads a thread back from Slack, oldest first. A single
   * conversations.replies call returns only the oldest page, which on a
   * long thread would seed the opening and miss the recent discussion — the
   * opposite of useful for "raise a ticket for this issue above". So this
   * pages on `response_metadata.next_cursor` until `has_more` is false, no
   * cursor comes back, or THREAD_REPLIES_MAX_PAGES requests have been made,
   * then concatenates the pages in order. `limit` is the page size sent on
   * each request, not a cap on the total transcript returned — trimming the
   * transcript to what a chat turn can use is the caller's job.
   *
   * Needs channels:history, groups:history or im:history (already granted),
   * so this works in public channels, private channels and 1:1 DMs. In a
   * multi-person group DM the required mpim:history scope is not granted,
   * so the call rejects with a missing_scope error instead; this method does
   * not swallow that, so callers should treat a rejection as "no history
   * available" and proceed rather than fail the turn.
   *
   * `isBot` means specifically "this app posted it", not "some bot posted
   * it". Per @slack/types' GenericMessageEvent (the shape of an ordinary,
   * non-`bot_message`-subtype message — what a chat.postMessage call from
   * this app's bot token always produces), `user` is a required field and
   * is set to the posting bot user's id, while `bot_id` is merely optional
   * metadata present on every bot-authored message, ours or anyone else's.
   * So the only safe test is `user` matching this gateway's own captured
   * bot id; `bot_id` is not read here at all. A foreign bot's message (e.g.
   * a GitHub/Zapier/workflow-bot post) still carries its own `user` id in
   * the returned ThreadMessage, so a consumer can resolve and label it via
   * getUserDisplayName exactly like a human author — Slack bot users have
   * real profiles. The one shape this deliberately does not special-case is
   * a legacy `bot_message`-subtype event (old-style incoming-webhook
   * integrations with no associated bot user, where `user` is absent and
   * only a display-only `username` is provided): that message comes back
   * with `user: ""`, `isBot: false`, and no name to resolve — the caller's
   * existing fallback label for an unresolvable author covers it, so no
   * extra field was added here for it.
   */
  async fetchThreadReplies(channel: string, threadTs: string, limit: number): Promise<ThreadMessage[]> {
    const collected: ThreadMessage[] = [];
    let cursor: string | undefined;

    for (let page = 0; page < THREAD_REPLIES_MAX_PAGES; page++) {
      const res = await this.app.client.conversations.replies(
        cursor ? { channel, ts: threadTs, limit, cursor } : { channel, ts: threadTs, limit },
      );
      const messages = res.messages;
      if (Array.isArray(messages)) {
        for (const m of messages as Array<{ user?: string; text?: string; ts?: string }>) {
          collected.push({
            user: m.user ?? "",
            text: m.text ?? "",
            ts: m.ts ?? "",
            // Strictly "this app's own bot user", not "any bot". A message
            // this app posts through chat.postMessage always comes back as
            // a plain message event with `user` set to this gateway's own
            // bot user id (see the round-1 fix note above the method for
            // the evidence). `bot_id` alone is not a safe signal: it is set
            // on every bot-authored message, including a GitHub/Zapier/
            // workflow-bot post, and treating any bot_id as "self" would
            // present a third party's words to the agent as its own.
            isBot: this.botId !== undefined && m.user === this.botId,
          });
        }
      }

      const nextCursor = (res as { response_metadata?: { next_cursor?: string } }).response_metadata?.next_cursor;
      if (!res.has_more || !nextCursor) break;
      cursor = nextCursor;
    }

    return collected;
  }

  async getUserDisplayName(userId: string): Promise<string> {
    try {
      const res = await this.app.client.users.info({ user: userId });
      const user = res.user as
        | { profile?: { display_name?: string; real_name?: string }; real_name?: string }
        | undefined;
      return user?.profile?.display_name || user?.profile?.real_name || user?.real_name || userId;
    } catch {
      return userId;
    }
  }
}
