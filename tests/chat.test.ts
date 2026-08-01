import { describe, expect, it } from "vitest";
import { createChat } from "../src/chat.js";
import { STATE_KEYS } from "../src/constants.js";
import { FakeGateway, makeCtx, TEST_CONFIG } from "./helpers.js";

function setup(configOverrides = {}) {
  const bundle = makeCtx(configOverrides);
  const gateway = new FakeGateway();
  const chat = createChat({
    ctx: bundle.ctx,
    gateway,
    getConfig: async () => ({ ...TEST_CONFIG, ...configOverrides }),
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

  it("posts an apology (and does not throw) when getConfig rejects", async () => {
    const bundle = makeCtx();
    const gateway = new FakeGateway();
    const chat = createChat({
      ctx: bundle.ctx,
      gateway,
      getConfig: () => Promise.reject(new Error("config store down")),
      updateIntervalMs: 0,
    });
    await expect(chat.handleMessage(dm("hi", "400.1"))).resolves.toBeUndefined();
    expect(gateway.posts.at(-1)!.text).toContain("something went wrong");
    expect(bundle.ctx.agents.sessions.create).not.toHaveBeenCalled();
  });

  it("clears the pending debounce timer when sendMessage rejects, so it can't overwrite the error message later", async () => {
    const bundle = makeCtx();
    const gateway = new FakeGateway();
    const chat = createChat({
      ctx: bundle.ctx,
      gateway,
      getConfig: async () => TEST_CONFIG,
      updateIntervalMs: 5,
    });
    (bundle.ctx.agents.sessions.sendMessage as any).mockImplementationOnce(
      async (_sessionId: string, _companyId: string, opts: { onEvent?: (e: unknown) => void }) => {
        // Schedule a debounced update from a buffered chunk, then fail the
        // outer call before that timer would fire.
        opts.onEvent?.({
          sessionId: "sess-1", runId: "run-1", seq: 1,
          eventType: "chunk", stream: "stdout", message: "stale partial buffer", payload: null,
        });
        throw new Error("network down");
      },
    );

    await chat.handleMessage(dm("hi", "500.1"));
    const updateCountAfterHandle = gateway.updates.length;
    expect(gateway.updates.at(-1)!.text).toContain("Failed to reach the agent");

    // Wait past the debounce interval to prove no leaked timer fires and
    // overwrites the error message with the stale buffered text.
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(gateway.updates.length).toBe(updateCountAfterHandle);
    expect(gateway.updates.at(-1)!.text).toContain("Failed to reach the agent");
  });

  it("does not throw when ctx.state.get rejects during handleMessage's channel-thread routing", async () => {
    const { ctx, chat } = setup();
    (ctx.state.get as any).mockRejectedValueOnce(new Error("state store down"));
    await expect(
      chat.handleMessage({
        channel: "C1", channelType: "channel", user: "U1", text: "hi", ts: "60.1", threadTs: "60.1",
      }),
    ).resolves.toBeUndefined();
    expect(ctx.logger.error).toHaveBeenCalled();
    expect(ctx.agents.sessions.create).not.toHaveBeenCalled();
  });

  it("splits a long final reply: placeholder gets the first chunk, the remainder posts as additional thread messages", async () => {
    const { ctx, gateway, chat } = setup();
    const longText = "a".repeat(9000);
    (ctx.agents.sessions.sendMessage as any).mockImplementationOnce(
      async (_sessionId: string, _companyId: string, opts: { onEvent?: (e: unknown) => void }) => {
        opts.onEvent?.({
          sessionId: "sess-1", runId: "run-1", seq: 1,
          eventType: "done", stream: null, message: longText, payload: null,
        });
        return { runId: "run-1" };
      },
    );

    await chat.handleMessage(dm("hi", "800.1"));

    const placeholderTs = gateway.posts[0]!.ts;
    const placeholderUpdate = gateway.updates.find((u) => u.ts === placeholderTs);
    expect(placeholderUpdate!.text.length).toBe(3900);
    expect(placeholderUpdate!.text).toBe(longText.slice(0, 3900));

    const extraPosts = gateway.posts.slice(1);
    expect(extraPosts.length).toBe(2); // 9000 chars = 3900 + 3900 + 1200
    for (const post of extraPosts) expect(post.threadTs).toBe("800.1");

    const rejoined = placeholderUpdate!.text + extraPosts.map((p) => p.text).join("");
    expect(rejoined).toBe(longText);
  });

  it("converts Markdown in the final agent reply to Slack mrkdwn before posting", async () => {
    const { ctx, gateway, chat } = setup();
    (ctx.agents.sessions.sendMessage as any).mockImplementationOnce(
      async (_sessionId: string, _companyId: string, opts: { onEvent?: (e: unknown) => void }) => {
        opts.onEvent?.({
          sessionId: "sess-1", runId: "run-1", seq: 1,
          eventType: "done", stream: null,
          message: "**bold** and [link](https://x.example)", payload: null,
        });
        return { runId: "run-1" };
      },
    );

    await chat.handleMessage(dm("hi", "900.1"));

    expect(gateway.updates.at(-1)!.text).toBe("*bold* and <https://x.example|link>");
  });

  it("creates only one session when two first messages race in the same thread", async () => {
    const { ctx, chat } = setup();
    await Promise.all([
      chat.handleMessage(dm("first", "700.1")),
      chat.handleMessage(dm("second", "700.2", "700.1")),
    ]);
    expect(ctx.agents.sessions.create).toHaveBeenCalledTimes(1);
  });
});
