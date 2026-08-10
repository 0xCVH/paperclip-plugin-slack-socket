import { describe, expect, it, vi } from "vitest";
import { shouldDispatchMessage } from "../src/bolt-gateway.js";
import { isDmChannelId } from "../src/slack-ids.js";

describe("shouldDispatchMessage", () => {
  it("dispatches a plain human message with no subtype", () => {
    expect(shouldDispatchMessage({ user: "U1" })).toBe(true);
  });

  it("dispatches a file_share message so an attachment does not swallow the text", () => {
    expect(shouldDispatchMessage({ subtype: "file_share", user: "U1" })).toBe(true);
  });

  it("dispatches a thread_broadcast message", () => {
    expect(shouldDispatchMessage({ subtype: "thread_broadcast", user: "U1" })).toBe(true);
  });

  it("drops a message_changed edit event", () => {
    expect(shouldDispatchMessage({ subtype: "message_changed", user: "U1" })).toBe(false);
  });

  it("drops any other subtype it has not been told to pass through", () => {
    expect(shouldDispatchMessage({ subtype: "message_deleted", user: "U1" })).toBe(false);
    expect(shouldDispatchMessage({ subtype: "channel_join", user: "U1" })).toBe(false);
  });

  it("drops a bot message even when its subtype is allowed", () => {
    expect(shouldDispatchMessage({ bot_id: "B1", user: "U1" })).toBe(false);
    expect(shouldDispatchMessage({ subtype: "file_share", bot_id: "B1", user: "U1" })).toBe(false);
  });

  it("drops a message with no authoring user", () => {
    expect(shouldDispatchMessage({})).toBe(false);
    expect(shouldDispatchMessage({ user: "" })).toBe(false);
    expect(shouldDispatchMessage({ subtype: "file_share" })).toBe(false);
  });
});

describe("isDmChannelId", () => {
  // Slack's app_mention event carries no channel_type field (unlike
  // `message`), so the app_mention handler in bolt-gateway.ts derives
  // channelType from the channel id's prefix via this function instead of
  // hardcoding "channel". Before that fix, "@bot hi" inside a 1:1 DM was
  // tagged channelType: "channel" and got a fresh, thread-scoped session
  // while a plain "hi" in the same DM got the remembered channel-scoped
  // one — two divergent histories in one conversation, chosen only by
  // whether the person happened to type the bot's name.
  it('is true for a DM (im) conversation id, which always starts with "D"', () => {
    expect(isDmChannelId("D0123456789")).toBe(true);
  });

  it("is false for a public channel id", () => {
    expect(isDmChannelId("C0123456789")).toBe(false);
  });

  it("is false for a private channel or group DM id (both share the G prefix)", () => {
    expect(isDmChannelId("G0123456789")).toBe(false);
  });
});

// --- Harness: mocks @slack/bolt's App so BoltGateway's real event wiring is
// exercised, not just the pure filters above. The reviewer verified that
// reverting app_mention's channelType from isDmChannelId(...) back to a
// hardcoded "channel" left all 327 existing tests green, because the chat
// tests build their InboundMessage by hand instead of going through
// BoltGateway's own Bolt handler.
const { appInstances, MockApp } = vi.hoisted(() => {
  const instances: InstanceType<typeof MockApp>[] = [];
  class MockApp {
    handlers = new Map<string, (arg: unknown) => Promise<void>>();
    client = {
      auth: { test: vi.fn().mockResolvedValue({ ok: true, user_id: "UBOT" }) },
      conversations: { replies: vi.fn().mockResolvedValue({ ok: true, messages: [] }) },
    };
    constructor(public opts: unknown) {
      instances.push(this);
    }
    event(name: string, handler: (arg: unknown) => Promise<void>): void {
      this.handlers.set(name, handler);
    }
    message(handler: (arg: unknown) => Promise<void>): void {
      this.handlers.set("message", handler);
    }
    action(): void {}
    command(): void {}
    async start(): Promise<void> {}
    async stop(): Promise<void> {}
  }
  return { appInstances: instances, MockApp };
});

vi.mock("@slack/bolt", () => ({ default: { App: MockApp } }));

describe("BoltGateway (against a mocked @slack/bolt App)", () => {
  async function makeGateway() {
    appInstances.length = 0;
    const { BoltGateway } = await import("../src/bolt-gateway.js");
    return new BoltGateway({ botToken: "xoxb", appToken: "xapp", logger: { warn: vi.fn() } });
  }

  it('tags an app_mention in a "D…" channel as channelType "im"', async () => {
    const gateway = await makeGateway();
    const received: Array<{ channelType: string }> = [];
    gateway.onMention(async (msg) => void received.push(msg));
    await appInstances[0]!.handlers.get("app_mention")!({
      event: { channel: "D0123456789", user: "U1", text: "hi", ts: "1.1" },
    });
    expect(received[0]!.channelType).toBe("im");
  });

  it('tags an app_mention in a "C…" channel as channelType "channel"', async () => {
    const gateway = await makeGateway();
    const received: Array<{ channelType: string }> = [];
    gateway.onMention(async (msg) => void received.push(msg));
    await appInstances[0]!.handlers.get("app_mention")!({
      event: { channel: "C0123456789", user: "U1", text: "hi", ts: "1.1" },
    });
    expect(received[0]!.channelType).toBe("channel");
  });

  it("probe() returns true when auth.test resolves ok", async () => {
    const gateway = await makeGateway();
    await expect(gateway.probe()).resolves.toBe(true);
  });

  it("probe() returns false when auth.test throws", async () => {
    const gateway = await makeGateway();
    appInstances[0]!.client.auth.test.mockRejectedValueOnce(new Error("revoked"));
    await expect(gateway.probe()).resolves.toBe(false);
  });

  it("fetchThreadReplies maps a conversations.replies payload to ThreadMessage[]", async () => {
    const gateway = await makeGateway();
    appInstances[0]!.client.conversations.replies.mockResolvedValueOnce({
      ok: true,
      messages: [
        { user: "U9", text: "Action needed: claimable subdomain", ts: "1.1", bot_id: "B1" },
        { user: "U1", text: "can you open a ticket for this?", ts: "1.2" },
      ],
    });

    await expect(gateway.fetchThreadReplies("C1", "1.1", 50)).resolves.toEqual([
      { user: "U9", text: "Action needed: claimable subdomain", ts: "1.1", isBot: true },
      { user: "U1", text: "can you open a ticket for this?", ts: "1.2", isBot: false },
    ]);
    expect(appInstances[0]!.client.conversations.replies).toHaveBeenCalledWith({
      channel: "C1", ts: "1.1", limit: 50,
    });
  });

  it("marks the bot's own user id as isBot even when Slack sends no bot_id", async () => {
    const gateway = await makeGateway();
    await gateway.start(); // captures user_id "UBOT" from auth.test
    appInstances[0]!.client.conversations.replies.mockResolvedValueOnce({
      ok: true,
      messages: [{ user: "UBOT", text: "posted through slack_post_message", ts: "1.1" }],
    });

    const replies = await gateway.fetchThreadReplies("C1", "1.1", 50);
    expect(replies[0]!.isBot).toBe(true);
  });

  it("returns [] when the payload carries no messages array", async () => {
    const gateway = await makeGateway();
    appInstances[0]!.client.conversations.replies.mockResolvedValueOnce({ ok: true });
    await expect(gateway.fetchThreadReplies("C1", "1.1", 50)).resolves.toEqual([]);
  });

  it("defaults absent user/text to empty strings without mistaking them for the bot", async () => {
    // start() was not called, so botUserId() is undefined. A naive
    // `m.user === this.botId` would make undefined === undefined true and
    // label a file-only post as the bot's own words.
    const gateway = await makeGateway();
    appInstances[0]!.client.conversations.replies.mockResolvedValueOnce({
      ok: true,
      messages: [{ ts: "1.3" }],
    });
    await expect(gateway.fetchThreadReplies("C1", "1.1", 50)).resolves.toEqual([
      { user: "", text: "", ts: "1.3", isBot: false },
    ]);
  });

  it("stitches two conversations.replies pages into one transcript, oldest first", async () => {
    // A1.1: a single conversations.replies call returns the parent plus only
    // the OLDEST page of replies. Paging on next_cursor is what lets a long
    // thread's most recent messages — normally what "this issue above"
    // refers to — reach the transcript at all.
    const gateway = await makeGateway();
    appInstances[0]!.client.conversations.replies
      .mockResolvedValueOnce({
        ok: true,
        has_more: true,
        response_metadata: { next_cursor: "cursor-1" },
        messages: [
          { user: "U9", text: "Action needed: claimable subdomain", ts: "1.1", bot_id: "B1" },
          { user: "U1", text: "can you open a ticket for this?", ts: "1.2" },
        ],
      })
      .mockResolvedValueOnce({
        ok: true,
        has_more: false,
        messages: [{ user: "U2", text: "on it", ts: "1.3" }],
      });

    await expect(gateway.fetchThreadReplies("C1", "1.1", 200)).resolves.toEqual([
      { user: "U9", text: "Action needed: claimable subdomain", ts: "1.1", isBot: true },
      { user: "U1", text: "can you open a ticket for this?", ts: "1.2", isBot: false },
      { user: "U2", text: "on it", ts: "1.3", isBot: false },
    ]);
    expect(appInstances[0]!.client.conversations.replies).toHaveBeenCalledTimes(2);
    expect(appInstances[0]!.client.conversations.replies).toHaveBeenNthCalledWith(1, {
      channel: "C1", ts: "1.1", limit: 200,
    });
    expect(appInstances[0]!.client.conversations.replies).toHaveBeenNthCalledWith(2, {
      channel: "C1", ts: "1.1", limit: 200, cursor: "cursor-1",
    });
  });

  it("stops paging after 5 requests so a runaway thread cannot hang a turn", async () => {
    const gateway = await makeGateway();
    appInstances[0]!.client.conversations.replies.mockResolvedValue({
      ok: true,
      has_more: true,
      response_metadata: { next_cursor: "cursor-more" },
      messages: [{ user: "U1", text: "msg", ts: "1.1" }],
    });

    const replies = await gateway.fetchThreadReplies("C1", "1.1", 200);
    expect(replies).toHaveLength(5);
    expect(appInstances[0]!.client.conversations.replies).toHaveBeenCalledTimes(5);
  });
});
