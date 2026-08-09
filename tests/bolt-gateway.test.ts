import { describe, expect, it } from "vitest";
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
