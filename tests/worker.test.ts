import { describe, expect, it } from "vitest";
import plugin, { startRuntime } from "../src/worker.js";
import { JOB_KEYS, SLASH_COMMAND, TOOL_NAMES } from "../src/constants.js";
import { FakeGateway, makeCtx } from "./helpers.js";

describe("startRuntime", () => {
  it("stays degraded and does not start the gateway when unconfigured", async () => {
    const { ctx } = makeCtx({ slackBotTokenRef: "", companyId: "" });
    const gateway = new FakeGateway();
    const health = await startRuntime(ctx, () => gateway);
    expect(health.status).toBe("degraded");
    expect(gateway.started).toBe(false);
  });

  it("goes degraded when secret resolution fails", async () => {
    const { ctx } = makeCtx();
    (ctx.secrets.resolve as any).mockRejectedValue(new Error("secrets disabled"));
    const gateway = new FakeGateway();
    const health = await startRuntime(ctx, () => gateway);
    expect(health.status).toBe("degraded");
    expect(gateway.started).toBe(false);
  });

  it("starts the gateway, registers the tool, job, command and action handlers when configured", async () => {
    const { ctx } = makeCtx();
    const gateway = new FakeGateway();
    const health = await startRuntime(ctx, (opts) => {
      expect(opts.botToken).toBe("secret-ref-bot");
      expect(opts.appToken).toBe("secret-ref-app");
      return gateway;
    });
    expect(health.status).toBe("ok");
    expect(gateway.started).toBe(true);
    expect((ctx.tools.register as any).mock.calls[0][0]).toBe(TOOL_NAMES.askHuman);
    expect((ctx.jobs.register as any).mock.calls[0][0]).toBe(JOB_KEYS.cleanup);
    // end-to-end through the wiring: a slash command reaches the commands module
    await gateway.emitCommand({ command: SLASH_COMMAND, text: "help", user: "U1", channel: "C1" });
    expect(gateway.ephemerals).toHaveLength(1);
  });

  it("routes answer-mode question replies away from chat", async () => {
    const { ctx, stateStore } = makeCtx();
    const gateway = new FakeGateway();
    await startRuntime(ctx, () => gateway);
    const { STATE_KEYS } = await import("../src/constants.js");
    stateStore.set(STATE_KEYS.question("C1", "10.1"), {
      channel: "C1", ts: "10.1", issueId: "iss-1", companyId: "co-1", mode: "answer",
      question: "Q?", askedAt: new Date().toISOString(), timeoutMinutes: 60,
    });
    // The reply's own ts must be recent (not "10.2") because the event
    // deduper now filters stale message ts values before this ever reaches
    // ask-human's answer routing; threadTs ("10.1") is the pending
    // question's key and is independent of that freshness check.
    const replyTs = (Date.now() / 1000).toFixed(6);
    await gateway.emitMessage({
      channel: "C1", channelType: "channel", user: "U5", text: "the answer", ts: replyTs, threadTs: "10.1",
    });
    expect(ctx.issues.createComment).toHaveBeenCalled();
    expect(ctx.agents.sessions.sendMessage).not.toHaveBeenCalled();
  });

  it("dedupes a message emitted twice, producing only one sendMessage call", async () => {
    const { ctx } = makeCtx();
    const gateway = new FakeGateway();
    await startRuntime(ctx, () => gateway);
    const ts = (Date.now() / 1000).toFixed(6);
    const msg = { channel: "D1", channelType: "im" as const, user: "U1", text: "hi", ts };
    await gateway.emitMessage(msg);
    await gateway.emitMessage(msg);
    expect(ctx.agents.sessions.sendMessage).toHaveBeenCalledTimes(1);
  });
});

describe("onValidateConfig", () => {
  it("returns ok:false with per-field errors for missing required fields, without throwing", async () => {
    const result = await plugin.definition.onValidateConfig?.({});
    expect(result?.ok).toBe(false);
    expect(result?.errors).toEqual(
      expect.arrayContaining([
        "slackBotTokenRef is required",
        "slackAppTokenRef is required",
        "companyId is required",
        "defaultAgentId is required",
        "defaultChannelId is required",
      ]),
    );
  });

  it("returns ok:false (not ok:true) when all required fields are present but the plugin context was never initialized", async () => {
    // No plugin.setup() call has happened in this test file, so the
    // module-level plugin context is still null. All required fields are
    // present, so the loop above finds no errors — but validation genuinely
    // could not run, and must not be reported as a pass.
    const result = await plugin.definition.onValidateConfig?.({
      slackBotTokenRef: "ref-bot",
      slackAppTokenRef: "ref-app",
      companyId: "co-1",
      defaultAgentId: "agent-1",
      defaultChannelId: "C-DEFAULT",
    });
    expect(result?.ok).toBe(false);
    expect(result?.errors).toEqual(["Validation unavailable: plugin context not initialized"]);
  });
});
