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
    client = { auth: { test: vi.fn().mockResolvedValue({ ok: true, user_id: "UBOT" }) } };
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
});
