import { describe, expect, it } from "vitest";
import { createChat } from "../src/chat.js";
import { STATE_KEYS } from "../src/constants.js";
import { loadConfig } from "../src/config.js";
import { FakeGateway, makeCtx } from "./helpers.js";

function setup(configOverrides = {}) {
  const bundle = makeCtx(configOverrides);
  const gateway = new FakeGateway();
  const chat = createChat({
    ctx: bundle.ctx,
    gateway,
    getConfig: () => loadConfig(bundle.ctx),
    updateIntervalMs: 0,
  });
  return { ...bundle, gateway, chat };
}

const dm = (text: string, ts: string, threadTs?: string) => ({
  channel: "D1", channelType: "im" as const, user: "U1", text, ts, threadTs,
});

describe("chat", () => {
  it("creates a session for a new DM thread and posts the agent reply", async () => {
    const { ctx, gateway, chat, stateStore } = setup();
    await chat.handleMessage(dm("hi", "100.1"));
    expect(ctx.agents.sessions.create).toHaveBeenCalledWith("agent-1", "co-1", expect.anything());
    // placeholder post then updated with the final reply
    expect(gateway.posts[0]!.threadTs).toBe("100.1");
    expect(gateway.updates.at(-1)!.text).toBe("Hello there!");
    expect(stateStore.get(STATE_KEYS.session("D1", "100.1"))).toBeTruthy();
    expect(stateStore.get(STATE_KEYS.sessionIndex)).toContain(STATE_KEYS.session("D1", "100.1"));
  });

  it("reuses the session for a reply in the same thread", async () => {
    const { ctx, chat } = setup();
    await chat.handleMessage(dm("hi", "100.1"));
    await chat.handleMessage(dm("again", "100.2", "100.1"));
    expect(ctx.agents.sessions.create).toHaveBeenCalledTimes(1);
    expect(ctx.agents.sessions.sendMessage).toHaveBeenCalledTimes(2);
  });

  it("ignores channel messages without an existing thread session", async () => {
    const { ctx, chat } = setup();
    await chat.handleMessage({
      channel: "C1", channelType: "channel", user: "U1", text: "random chatter", ts: "1.1",
    });
    expect(ctx.agents.sessions.create).not.toHaveBeenCalled();
  });

  it("handles a channel thread reply when a session exists for the thread", async () => {
    const { ctx, chat, stateStore } = setup();
    stateStore.set(STATE_KEYS.session("C1", "50.1"), {
      sessionId: "sess-9", channel: "C1", threadTs: "50.1", lastActivityAt: new Date().toISOString(),
    });
    await chat.handleMessage({
      channel: "C1", channelType: "channel", user: "U1", text: "follow-up", ts: "50.2", threadTs: "50.1",
    });
    expect(ctx.agents.sessions.sendMessage).toHaveBeenCalledWith("sess-9", "co-1", expect.anything());
  });

  it("skips messages containing the bot mention (handled by handleMention)", async () => {
    const { ctx, chat } = setup();
    await chat.handleMessage(dm("<@UBOT> hello", "9.1"));
    expect(ctx.agents.sessions.create).not.toHaveBeenCalled();
  });

  it("strips the bot mention from mention prompts", async () => {
    const { ctx, chat } = setup();
    await chat.handleMention({
      channel: "C1", channelType: "channel", user: "U1", text: "<@UBOT> help me", ts: "2.1",
    });
    const call = (ctx.agents.sessions.sendMessage as any).mock.calls[0];
    expect(call[2].prompt).toBe("help me");
  });

  it("posts an apology in the thread when the session fails", async () => {
    const { ctx, gateway, chat } = setup();
    (ctx.agents.sessions.create as any).mockRejectedValueOnce(new Error("no agent"));
    await chat.handleMessage(dm("hi", "100.1"));
    expect(gateway.posts.at(-1)!.text).toContain("something went wrong");
  });
});
