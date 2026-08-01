import { beforeEach, describe, expect, it, vi } from "vitest";
import { JOB_KEYS, SLASH_COMMAND, STATE_KEYS, TOOL_NAMES } from "../src/constants.js";
import { FakeGateway, makeCtx, TEST_CONFIG } from "./helpers.js";

// Stub @slack/web-api so onValidateConfig's success path never makes a real
// network call — it constructs a WebClient and calls auth.test() /
// apps.connections.open() directly.
vi.mock("@slack/web-api", () => ({
  WebClient: vi.fn().mockImplementation(() => ({
    auth: { test: vi.fn().mockResolvedValue({ ok: true }) },
    apps: { connections: { open: vi.fn().mockResolvedValue({ ok: true }) } },
  })),
}));

// Stub BoltGateway so the real, host-facing `onConfigChanged` hook can be
// exercised end-to-end (companyId reaching secrets.resolve, a gateway
// actually getting started/stopped) without opening a real Socket Mode
// connection. vi.hoisted so the class is available inside vi.mock's factory.
const { boltGatewayInstances, BoltGatewayMock } = vi.hoisted(() => {
  const instances: Array<{ started: boolean; opts: unknown }> = [];
  class Mock {
    started = false;
    opts: unknown;
    private botId = "UBOT";
    constructor(opts: unknown) {
      this.opts = opts;
      instances.push(this);
    }
    async start(): Promise<void> {
      this.started = true;
    }
    async stop(): Promise<void> {
      this.started = false;
    }
    isConnected(): boolean {
      return this.started;
    }
    botUserId(): string {
      return this.botId;
    }
    async postMessage(): Promise<{ channel: string; ts: string }> {
      return { channel: "C", ts: "1" };
    }
    async updateMessage(): Promise<void> {}
    async postEphemeral(): Promise<void> {}
    async openDm(userId: string): Promise<string> {
      return `D-${userId}`;
    }
    async getUserDisplayName(userId: string): Promise<string> {
      return userId;
    }
    onMessage(): void {}
    onMention(): void {}
    onReaction(): void {}
    onAction(): void {}
    onCommand(): void {}
  }
  return { boltGatewayInstances: instances, BoltGatewayMock: Mock };
});

vi.mock("../src/bolt-gateway.js", () => ({ BoltGateway: BoltGatewayMock }));

/** Re-imports src/worker.js as a fresh module instance so its module-level
 * runtime state (liveConfig, currentGateway, the cached module set, etc.)
 * doesn't leak between tests. */
async function loadWorker() {
  vi.resetModules();
  return import("../src/worker.js");
}

function cfg(overrides: Partial<typeof TEST_CONFIG> = {}) {
  return { ...TEST_CONFIG, ...overrides };
}

beforeEach(() => {
  boltGatewayInstances.length = 0;
});

describe("applyConfig", () => {
  it("stays degraded and does not start the gateway when required fields are missing", async () => {
    const { applyConfig } = await loadWorker();
    const { ctx } = makeCtx();
    const gateway = new FakeGateway();
    const health = await applyConfig(ctx, cfg({ slackBotTokenRef: "", companyId: "" }), () => gateway);
    expect(health.status).toBe("degraded");
    expect(gateway.started).toBe(false);
  });

  it("goes degraded when secret resolution fails", async () => {
    const { applyConfig } = await loadWorker();
    const { ctx } = makeCtx();
    (ctx.secrets.resolve as any).mockRejectedValue(new Error("secrets disabled"));
    const gateway = new FakeGateway();
    const health = await applyConfig(ctx, cfg(), () => gateway);
    expect(health.status).toBe("degraded");
    expect(gateway.started).toBe(false);
  });

  it("passes { companyId } as the second arg to ctx.secrets.resolve for both Slack tokens", async () => {
    // This is the user-facing bug: secrets.resolve() outside an invocation
    // fails with "company context is required" unless companyId is passed
    // explicitly.
    const { applyConfig } = await loadWorker();
    const { ctx } = makeCtx();
    const gateway = new FakeGateway();
    await applyConfig(ctx, cfg(), () => gateway);
    expect(ctx.secrets.resolve).toHaveBeenCalledWith("ref-bot", { companyId: "co-1" });
    expect(ctx.secrets.resolve).toHaveBeenCalledWith("ref-app", { companyId: "co-1" });
  });

  it("starts the gateway, registers the tool, command and action handlers when configured", async () => {
    const { applyConfig } = await loadWorker();
    const { ctx } = makeCtx();
    const gateway = new FakeGateway();
    const health = await applyConfig(ctx, cfg(), (opts) => {
      expect(opts.botToken).toBe("secret-ref-bot");
      expect(opts.appToken).toBe("secret-ref-app");
      return gateway;
    });
    expect(health.status).toBe("ok");
    expect(gateway.started).toBe(true);
    // Tool registration happens in ensureModules, which applyConfig also
    // triggers (idempotently) so this seam works standalone in tests too.
    expect((ctx.tools.register as any).mock.calls[0][0]).toBe(TOOL_NAMES.askHuman);
    // end-to-end through the wiring: a slash command reaches the commands module
    await gateway.emitCommand({ command: SLASH_COMMAND, text: "help", user: "U1", channel: "C1" });
    expect(gateway.ephemerals).toHaveLength(1);
  });

  it("registers the cleanup job once setup() has run, and it uses the live gateway", async () => {
    const { default: plugin, applyConfig } = await loadWorker();
    const { ctx } = makeCtx();
    await plugin.definition.setup(ctx);
    expect((ctx.jobs.register as any).mock.calls[0][0]).toBe(JOB_KEYS.cleanup);
    const gateway = new FakeGateway();
    await applyConfig(ctx, cfg(), () => gateway);
    const jobHandler = (ctx.jobs.register as any).mock.calls[0][1] as () => Promise<void>;
    await expect(jobHandler()).resolves.toBeUndefined();
  });

  it("routes answer-mode question replies away from chat", async () => {
    const { applyConfig } = await loadWorker();
    const { ctx, stateStore } = makeCtx();
    const gateway = new FakeGateway();
    await applyConfig(ctx, cfg(), () => gateway);
    stateStore.set(STATE_KEYS.question("C1", "10.1"), {
      channel: "C1", ts: "10.1", issueId: "iss-1", companyId: "co-1", mode: "answer",
      question: "Q?", askedAt: new Date().toISOString(), timeoutMinutes: 60,
    });
    // The reply's own ts must be recent (not "10.2") because the event
    // deduper filters stale message ts values before this ever reaches
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
    const { applyConfig } = await loadWorker();
    const { ctx } = makeCtx();
    const gateway = new FakeGateway();
    await applyConfig(ctx, cfg(), () => gateway);
    const ts = (Date.now() / 1000).toFixed(6);
    const msg = { channel: "D1", channelType: "im" as const, user: "U1", text: "hi", ts };
    await gateway.emitMessage(msg);
    await gateway.emitMessage(msg);
    expect(ctx.agents.sessions.sendMessage).toHaveBeenCalledTimes(1);
  });

  it("does not drop a channel @mention when its message.channels event (same ts) is processed first — dedup keys are namespaced per event type", async () => {
    const { applyConfig } = await loadWorker();
    const { ctx } = makeCtx();
    const gateway = new FakeGateway();
    await applyConfig(ctx, cfg(), () => gateway);
    const ts = (Date.now() / 1000).toFixed(6);
    const text = "<@UBOT> help me";
    await gateway.emitMessage({ channel: "C1", channelType: "channel", user: "U1", text, ts });
    await gateway.emitMention({ channel: "C1", channelType: "channel", user: "U1", text, ts });
    expect(ctx.agents.sessions.sendMessage).toHaveBeenCalledTimes(1);
  });

  it("a second applyConfig call stops the old gateway and starts a new one", async () => {
    const { applyConfig } = await loadWorker();
    const { ctx } = makeCtx();
    const gatewayA = new FakeGateway();
    const gatewayB = new FakeGateway();
    await applyConfig(ctx, cfg(), () => gatewayA);
    expect(gatewayA.started).toBe(true);
    const health = await applyConfig(ctx, cfg({ defaultChannelId: "C-OTHER" }), () => gatewayB);
    expect(gatewayA.started).toBe(false);
    expect(gatewayB.started).toBe(true);
    expect(health.status).toBe("ok");
  });

  it("never calls ctx.config.get during normal operation", async () => {
    const { applyConfig } = await loadWorker();
    const { ctx } = makeCtx();
    const gateway = new FakeGateway();
    await applyConfig(ctx, cfg(), () => gateway);
    const ts = (Date.now() / 1000).toFixed(6);
    await gateway.emitMessage({ channel: "D1", channelType: "im", user: "U1", text: "hi", ts });
    await gateway.emitCommand({ command: SLASH_COMMAND, text: "help", user: "U1", channel: "C1" });
    expect(ctx.config.get).not.toHaveBeenCalled();
  });
});

describe("plugin.definition.onConfigChanged (the real host-facing hook)", () => {
  it("resolves both Slack secrets with { companyId } and starts a BoltGateway", async () => {
    const { default: plugin } = await loadWorker();
    const { ctx } = makeCtx();
    await plugin.definition.setup(ctx);
    await plugin.definition.onConfigChanged?.(cfg());
    expect(ctx.secrets.resolve).toHaveBeenCalledWith("ref-bot", { companyId: "co-1" });
    expect(ctx.secrets.resolve).toHaveBeenCalledWith("ref-app", { companyId: "co-1" });
    expect(boltGatewayInstances).toHaveLength(1);
    expect(boltGatewayInstances[0]!.started).toBe(true);
    await expect(plugin.definition.onHealth?.()).resolves.toEqual({ status: "ok" });
  });

  it("swaps to a new BoltGateway on a second config change", async () => {
    const { default: plugin } = await loadWorker();
    const { ctx } = makeCtx();
    await plugin.definition.setup(ctx);
    await plugin.definition.onConfigChanged?.(cfg());
    await plugin.definition.onConfigChanged?.(cfg({ defaultChannelId: "C-OTHER" }));
    expect(boltGatewayInstances).toHaveLength(2);
    expect(boltGatewayInstances[0]!.started).toBe(false);
    expect(boltGatewayInstances[1]!.started).toBe(true);
  });

  it("reports degraded health with 'Waiting for configuration' before any config has arrived", async () => {
    const { default: plugin } = await loadWorker();
    const { ctx } = makeCtx();
    await plugin.definition.setup(ctx);
    const health = await plugin.definition.onHealth?.();
    expect(health?.status).toBe("degraded");
    expect(health?.message).toMatch(/waiting for configuration/i);
  });
});

describe("onValidateConfig", () => {
  it("returns ok:false with per-field errors for missing required fields, without throwing", async () => {
    const { default: plugin } = await loadWorker();
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
    const { default: plugin } = await loadWorker();
    // No plugin.setup() call has happened against this fresh module
    // instance, so its module-level plugin context is still null. All
    // required fields are present, so the loop above finds no errors — but
    // validation genuinely could not run, and must not be reported as a pass.
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

  it("passes { companyId } from the config being validated — not the cached live config — to ctx.secrets.resolve", async () => {
    const { default: plugin } = await loadWorker();
    const { ctx } = makeCtx();
    await plugin.definition.setup(ctx);
    // Deliberately never call onConfigChanged: liveConfig stays null/default
    // (companyId ""), so if onValidateConfig used the cached config instead
    // of the config it was handed, this assertion would fail.
    const result = await plugin.definition.onValidateConfig?.({
      slackBotTokenRef: "ref-bot",
      slackAppTokenRef: "ref-app",
      companyId: "co-validate",
      defaultAgentId: "agent-1",
      defaultChannelId: "C-DEFAULT",
    });
    expect(result?.ok).toBe(true);
    expect(ctx.secrets.resolve).toHaveBeenCalledWith("ref-bot", { companyId: "co-validate" });
    expect(ctx.secrets.resolve).toHaveBeenCalledWith("ref-app", { companyId: "co-validate" });
  });
});
