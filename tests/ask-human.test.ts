import { describe, expect, it } from "vitest";
import { createAskHuman } from "../src/ask-human.js";
import { STATE_KEYS, TOOL_NAMES } from "../src/constants.js";
import type { PendingQuestion, SlackSocketConfig } from "../src/types.js";
import { FakeGateway, makeCtx, TEST_CONFIG } from "./helpers.js";

const RUN_CTX = { agentId: "agent-1", runId: "run-1", companyId: "co-1", projectId: "proj-1" };

function setup(configOverrides: Partial<SlackSocketConfig> = {}) {
  const bundle = makeCtx(configOverrides);
  const gateway = new FakeGateway();
  const askHuman = createAskHuman({
    ctx: bundle.ctx,
    gateway,
    getConfig: async () => ({ ...TEST_CONFIG, ...configOverrides }),
  });
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

  it("resolves a reaction only once when two identical reactions race for the same message", async () => {
    const { ctx, gateway, askHuman, stateStore } = setup();
    const key = STATE_KEYS.question("C1", "10.1");
    stateStore.set(key, pending());
    stateStore.set(STATE_KEYS.questionIndex, [key]);
    const reaction = { channel: "C1", messageTs: "10.1", user: "U5", reaction: "+1" };
    await Promise.all([askHuman.handleReaction(reaction), askHuman.handleReaction(reaction)]);
    expect(ctx.issues.createComment).toHaveBeenCalledTimes(1);
    expect(ctx.issues.requestWakeup).toHaveBeenCalledTimes(1);
    expect(gateway.updates).toHaveLength(1);
  });

  it("tracks concurrent asks without losing either questionIndex entry", async () => {
    const { handler, gateway, stateStore } = setup();
    const [first, second] = await Promise.all([
      handler({ question: "Ship it?", target: "C1", mode: "reaction", issueId: "iss-1" }, RUN_CTX),
      handler({ question: "Deploy now?", target: "C2", mode: "reaction", issueId: "iss-2" }, RUN_CTX),
    ]);
    expect(first.error).toBeUndefined();
    expect(second.error).toBeUndefined();
    expect(gateway.posts).toHaveLength(2);
    const keys = gateway.posts.map((p) => STATE_KEYS.question(p.channel, p.ts));
    const index = stateStore.get(STATE_KEYS.questionIndex) as string[];
    expect(index).toHaveLength(2);
    for (const key of keys) expect(index).toContain(key);
  });

  it("returns a tracking error and warns in Slack when state.set fails after a successful post", async () => {
    const { ctx, gateway, handler } = setup();
    (ctx.state.set as any).mockRejectedValueOnce(new Error("state store down"));
    const result = await handler(
      { question: "Ship it?", target: "C1", mode: "reaction", issueId: "iss-1" }, RUN_CTX,
    );
    expect(result.error).toMatch(/tracked/i);
    expect(gateway.posts).toHaveLength(1);
    const postedTs = gateway.posts[0]!.ts;
    expect(gateway.updates).toContainEqual(
      expect.objectContaining({ channel: "C1", ts: postedTs, text: expect.stringContaining("could not be tracked") }),
    );
    expect(ctx.logger.error).toHaveBeenCalled();
  });

  it("refuses a cross-tenant call: nothing posted to Slack and no state written", async () => {
    const { ctx, gateway, handler, stateStore } = setup();
    const foreignRunCtx = { agentId: "agent-2", runId: "run-2", companyId: "co-2", projectId: "proj-2" };
    const result = await handler(
      { question: "What is the prod DB password rotation date?", target: "C1", mode: "answer", issueId: "iss-9" },
      foreignRunCtx,
    );
    expect(result.error).toBe("Asking a human via Slack is not authorized for this company.");
    expect(result.error).not.toContain("co-1");
    expect(gateway.posts).toHaveLength(0);
    expect(gateway.dmOpens).toHaveLength(0);
    // A tracked question would harvest the human's answer onto the FOREIGN
    // company's issue (pending.companyId = runCtx.companyId), so the refusal
    // has to land before any state is written at all.
    expect(stateStore.size).toBe(0);
    expect(ctx.metrics.write).toHaveBeenCalledWith("slack.questions.refused", 1, { mode: "answer" });
    expect(ctx.logger.warn).toHaveBeenCalled();
  });

  it("still asks normally when the run company matches the bound config", async () => {
    const { ctx, gateway, handler, stateStore } = setup();
    const result = await handler(
      { question: "Ship it?", target: "C1", mode: "reaction", issueId: "iss-1" }, RUN_CTX,
    );
    expect(result.error).toBeUndefined();
    expect(gateway.posts).toHaveLength(1);
    expect(stateStore.get(STATE_KEYS.question("C1", gateway.posts[0]!.ts))).toMatchObject({ companyId: "co-1" });
    const names = (ctx.metrics.write as any).mock.calls.map((c: unknown[]) => c[0]);
    expect(names).toContain("slack.questions.asked");
    expect(names).not.toContain("slack.questions.refused");
  });

  it("returns an error instead of throwing when getConfig() rejects, without posting", async () => {
    const bundle = makeCtx();
    const gateway = new FakeGateway();
    const askHuman = createAskHuman({
      ctx: bundle.ctx,
      gateway,
      getConfig: async () => { throw new Error("config store unavailable"); },
    });
    askHuman.registerTool();
    const handler = (bundle.ctx.tools.register as any).mock.calls[0][2] as
      (params: unknown, runCtx: typeof RUN_CTX) => Promise<{ content?: string; error?: string }>;

    let result: { content?: string; error?: string } | undefined;
    await expect(
      (async () => {
        result = await handler(
          { question: "Ship it?", target: "C1", mode: "reaction", issueId: "iss-1" }, RUN_CTX,
        );
      })(),
    ).resolves.toBeUndefined();

    expect(result?.error).toContain("config store unavailable");
    expect(gateway.posts).toHaveLength(0);
  });
});
