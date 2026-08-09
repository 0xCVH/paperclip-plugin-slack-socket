import { describe, expect, it } from "vitest";
import { shouldDispatchMessage } from "../src/bolt-gateway.js";

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
