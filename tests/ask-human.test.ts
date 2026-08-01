import { describe, expect, it } from "vitest";
import { createAskHuman } from "../src/ask-human.js";
import { STATE_KEYS, TOOL_NAMES } from "../src/constants.js";
import type { PendingQuestion } from "../src/types.js";
import { FakeGateway, makeCtx } from "./helpers.js";

const RUN_CTX = { agentId: "agent-1", runId: "run-1", companyId: "co-1", projectId: "proj-1" };

function setup() {
  const bundle = makeCtx();
  const gateway = new FakeGateway();
  const askHuman = createAskHuman({ ctx: bundle.ctx, gateway });
  askHuman.registerTool();
  const toolCall = (bundle.ctx.tools.register as any).mock.calls[0];
  const handler = toolCall[2] as (params: unknown, runCtx: typeof RUN_CTX) => Promise<{ content?: string; error?: string }>;
  return { ...bundle, gateway, askHuman, toolName: toolCall[0] as string, handler };
}

const pending = (overrides: Partial<PendingQuestion> = {}): PendingQuestion => ({
  channel: "C1", ts: "10.1", issueId: "iss-1", companyId: "co-1",
  mode: "reaction", question: "Ship it?", askedAt: new Date().toISOString(), timeoutMinutes: 60,
  ...overrides,
});

describe("ask-human tool", () => {
  it("registers under the ask_human name and posts the question to a channel", async () => {
    const { toolName, handler, gateway, stateStore } = setup();
    expect(toolName).toBe(TOOL_NAMES.askHuman);
    const result = await handler(
      { question: "Ship it?", target: "C1", mode: "reaction", issueId: "iss-1" }, RUN_CTX,
    );
    expect(result.error).toBeUndefined();
    expect(gateway.posts).toHaveLength(1);
    const key = STATE_KEYS.question("C1", gateway.posts[0]!.ts);
    expect(stateStore.get(key)).toMatchObject({ issueId: "iss-1", mode: "reaction", companyId: "co-1" });
    expect(stateStore.get(STATE_KEYS.questionIndex)).toContain(key);
  });

  it("opens a DM when the target is a user id", async () => {
    const { handler, gateway } = setup();
    await handler({ question: "Q?", target: "U77", mode: "answer", issueId: "iss-1" }, RUN_CTX);
    expect(gateway.dmOpens).toEqual(["U77"]);
    expect(gateway.posts[0]!.channel).toBe("D-U77");
  });

  it("rejects missing params without posting", async () => {
    const { handler, gateway } = setup();
    const result = await handler({ question: "Q?" }, RUN_CTX);
    expect(result.error).toBeTruthy();
    expect(gateway.posts).toHaveLength(0);
  });

  it("records a reaction response, wakes the issue, and resolves the message", async () => {
    const { ctx, gateway, askHuman, stateStore } = setup();
    const key = STATE_KEYS.question("C1", "10.1");
    stateStore.set(key, pending());
    stateStore.set(STATE_KEYS.questionIndex, [key]);
    await askHuman.handleReaction({ channel: "C1", messageTs: "10.1", user: "U5", reaction: "+1" });
    expect(ctx.issues.createComment).toHaveBeenCalledWith(
      "iss-1", expect.stringContaining(":+1:"), "co-1",
    );
    expect(ctx.issues.requestWakeup).toHaveBeenCalledWith("iss-1", "co-1", expect.anything());
    expect(gateway.updates[0]!.ts).toBe("10.1");
    expect(stateStore.get(key)).toBeUndefined();
    expect(stateStore.get(STATE_KEYS.questionIndex)).toEqual([]);
  });

  it("ignores reactions when the pending question is answer-mode", async () => {
    const { ctx, askHuman, stateStore } = setup();
    stateStore.set(STATE_KEYS.question("C1", "10.1"), pending({ mode: "answer" }));
    await askHuman.handleReaction({ channel: "C1", messageTs: "10.1", user: "U5", reaction: "+1" });
    expect(ctx.issues.createComment).not.toHaveBeenCalled();
  });

  it("claims thread replies to answer-mode questions and records them", async () => {
    const { ctx, askHuman, stateStore } = setup();
    const key = STATE_KEYS.question("C1", "10.1");
    stateStore.set(key, pending({ mode: "answer" }));
    stateStore.set(STATE_KEYS.questionIndex, [key]);
    const claimed = await askHuman.tryHandleAnswer({
      channel: "C1", channelType: "channel", user: "U5", text: "Yes, ship it", ts: "10.2", threadTs: "10.1",
    });
    expect(claimed).toBe(true);
    expect(ctx.issues.createComment).toHaveBeenCalledWith(
      "iss-1", expect.stringContaining("Yes, ship it"), "co-1",
    );
  });

  it("does not claim unrelated messages", async () => {
    const { askHuman } = setup();
    const claimed = await askHuman.tryHandleAnswer({
      channel: "C1", channelType: "channel", user: "U5", text: "hello", ts: "1.2", threadTs: "1.1",
    });
    expect(claimed).toBe(false);
  });
});
