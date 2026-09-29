import { describe, it, expect } from "vitest";
import { createChat } from "../src/chat.js";
import { STATE_KEYS } from "../src/constants.js";
import { FakeGateway, makeCtx, TEST_CONFIG } from "./helpers.js";

describe("opt-in mentioned thread continuation", () => {
  function setup(enabled = true) {
    const bundle = makeCtx();
    const chat = createChat({ ctx: bundle.ctx, gateway: new FakeGateway(),
      getConfig: async () => ({ ...TEST_CONFIG, continueMentionedThreads: enabled }), updateIntervalMs: 0 });
    return { ...bundle, chat };
  }
  const message = { channel: "C1", channelType: "channel" as const, user: "U1", text: "follow up", ts: "50.2", threadTs: "50.1" };
  it("continues a thread established by a mention", async () => {
    const { chat, ctx } = setup();
    await chat.handleMention({ ...message, text: "<@UBOT> hi" });
    await chat.handleMessage(message);
    expect(ctx.agents.sessions.create).toHaveBeenCalledTimes(1);
    expect(ctx.agents.sessions.sendMessage).toHaveBeenCalledTimes(2);
  });
  for (const kind of ["missing", "expired", "wrong-agent", "disabled", "top-level", "duplicate-mention"]) {
    it(`ignores ${kind} follow-ups`, async () => {
      const { chat, ctx, stateStore } = setup(kind !== "disabled");
      if (kind !== "missing") stateStore.set(STATE_KEYS.session("C1", "50.1"), {
        sessionId: "sess-9", agentId: kind === "wrong-agent" ? "other" : "agent-1",
        channel: "C1", threadTs: "50.1", lastActivityAt: kind === "expired" ? "2000-01-01T00:00:00Z" : new Date().toISOString(),
      });
      await chat.handleMessage({ ...message, threadTs: kind === "top-level" ? undefined : message.threadTs,
        text: kind === "duplicate-mention" ? "<@UBOT> follow up" : message.text });
      expect(ctx.agents.sessions.sendMessage).not.toHaveBeenCalled();
    });
  }
});
