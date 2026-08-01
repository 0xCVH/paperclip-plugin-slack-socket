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
    await gateway.emitMessage({
      channel: "C1", channelType: "channel", user: "U5", text: "the answer", ts: "10.2", threadTs: "10.1",
    });
    expect(ctx.issues.createComment).toHaveBeenCalled();
    expect(ctx.agents.sessions.sendMessage).not.toHaveBeenCalled();
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
});
