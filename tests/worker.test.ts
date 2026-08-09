import { AsyncLocalStorage } from "node:async_hooks";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
const { boltGatewayInstances, BoltGatewayMock, alsCapture } = vi.hoisted(() => {
  const instances: Array<{ started: boolean; opts: unknown; probeResult: boolean }> = [];
  // Lets individual tests observe the ALS store active at the moment a
  // BoltGateway is constructed, without this file-level mock needing to
  // import node:async_hooks itself or know about any particular
  // AsyncLocalStorage instance up front. A test that cares sets
  // `alsCapture.als` to its own AsyncLocalStorage before invoking the
  // worker, and reads `alsCapture.captured` afterward.
  const alsCapture: { als: { getStore(): unknown } | null; captured: unknown } = {
    als: null,
    captured: "not-constructed",
  };
  class Mock {
    started = false;
    // Settable per instance so a test can simulate a socket Bolt still
    // believes is open but Slack no longer answers for (revoked token).
    probeResult = true;
    opts: unknown;
    private botId = "UBOT";
    constructor(opts: unknown) {
      this.opts = opts;
      instances.push(this);
      if (alsCapture.als) alsCapture.captured = alsCapture.als.getStore();
    }
    async start(): Promise<void> {
      // Test-controlled failure hook: a bot token of this exact sentinel
      // value makes gateway.start() throw, so tests can exercise the pump's
      // catch branch through the real, host-facing onConfigChanged path
      // (applyConfig only ever throws out of a gateway.start() failure).
      if ((this.opts as { botToken?: string }).botToken === "THROW_ON_START") {
        throw new Error("boom: gateway start failed");
      }
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
    async probe(): Promise<boolean> {
      return this.probeResult;
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
  return { boltGatewayInstances: instances, BoltGatewayMock: Mock, alsCapture };
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
  alsCapture.als = null;
  alsCapture.captured = "not-constructed";
});

// Belt-and-suspenders for the fake-timer test(s) below: guarantees real
// timers are restored even if a test throws before reaching its own
// cleanup. A no-op for every other test, which never enables fake timers.
afterEach(() => {
  vi.useRealTimers();
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
    expect((ctx.tools.register as any).mock.calls.map((c: unknown[]) => c[0])).toEqual([
      TOOL_NAMES.askHuman,
      TOOL_NAMES.postMessage,
    ]);
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

  it("routes an answer-mode question reply in a DM away from chat too — proves tryHandleAnswer still runs before handleMessage now that channels are mention-only", async () => {
    const { applyConfig } = await loadWorker();
    const { ctx, stateStore } = makeCtx();
    const gateway = new FakeGateway();
    await applyConfig(ctx, cfg(), () => gateway);
    stateStore.set(STATE_KEYS.question("D1", "10.1"), {
      channel: "D1", ts: "10.1", issueId: "iss-1", companyId: "co-1", mode: "answer",
      question: "Q?", askedAt: new Date().toISOString(), timeoutMinutes: 60,
    });
    // Same freshness note as the channel-thread test above: the reply's own
    // ts must be recent so the event deduper doesn't filter it before it
    // reaches ask-human's answer routing; threadTs ("10.1") is the pending
    // question's key and is independent of that check.
    const replyTs = (Date.now() / 1000).toFixed(6);
    await gateway.emitMessage({
      channel: "D1", channelType: "im", user: "U5", text: "the answer", ts: replyTs, threadTs: "10.1",
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

  it("a second applyConfig call for the SAME company stops the old gateway and starts a new one", async () => {
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

  it("subscribes ctx.events on the first bind only — a same-company reconfiguration does not double-subscribe", async () => {
    const { applyConfig } = await loadWorker();
    const { ctx } = makeCtx();
    await applyConfig(ctx, cfg(), () => new FakeGateway());
    const callsAfterFirst = (ctx.events.on as any).mock.calls.length;
    expect(callsAfterFirst).toBeGreaterThan(0); // issue.created/issue.updated/agent.run.failed/approval.created
    await applyConfig(ctx, cfg({ defaultChannelId: "C-OTHER" }), () => new FakeGateway());
    expect((ctx.events.on as any).mock.calls.length).toBe(callsAfterFirst);
  });

  it("an invalid second config leaves the first gateway running and getLiveConfig() returning the first config", async () => {
    const { applyConfig, getLiveConfig } = await loadWorker();
    const { ctx } = makeCtx();
    const gatewayA = new FakeGateway();
    const firstCfg = cfg();
    await applyConfig(ctx, firstCfg, () => gatewayA);
    expect(gatewayA.started).toBe(true);

    const gatewayB = new FakeGateway();
    const health = await applyConfig(ctx, cfg({ slackBotTokenRef: "" }), () => gatewayB);

    expect(health.status).toBe("degraded");
    expect(health.message).toMatch(/previous configuration is still active/i);
    expect(gatewayA.started).toBe(true);
    expect(gatewayB.started).toBe(false);
    expect(getLiveConfig()).toEqual(firstCfg);
  });

  it("a secret-resolution failure on a second config likewise leaves the first gateway running and the config unchanged", async () => {
    const { applyConfig, getLiveConfig } = await loadWorker();
    const { ctx } = makeCtx();
    const gatewayA = new FakeGateway();
    const firstCfg = cfg();
    await applyConfig(ctx, firstCfg, () => gatewayA);
    expect(gatewayA.started).toBe(true);

    (ctx.secrets.resolve as any).mockRejectedValueOnce(new Error("secrets disabled"));
    const gatewayB = new FakeGateway();
    const health = await applyConfig(ctx, cfg({ defaultChannelId: "C-OTHER" }), () => gatewayB);

    expect(health.status).toBe("degraded");
    expect(health.message).toMatch(/previous configuration is still active/i);
    expect(gatewayA.started).toBe(true);
    expect(gatewayB.started).toBe(false);
    expect(getLiveConfig()).toEqual(firstCfg);
  });

  it("refuses a config for a different company, leaves the first gateway running, and logs an error naming both company ids", async () => {
    const { applyConfig, getLiveConfig } = await loadWorker();
    const { ctx } = makeCtx();
    const gatewayA = new FakeGateway();
    const firstCfg = cfg();
    await applyConfig(ctx, firstCfg, () => gatewayA);
    expect(gatewayA.started).toBe(true);

    const gatewayB = new FakeGateway();
    const health = await applyConfig(ctx, cfg({ companyId: "co-2" }), () => gatewayB);

    expect(health.status).toBe("degraded");
    expect(health.message).toContain("co-1");
    expect(health.message).toContain("co-2");
    expect(gatewayA.started).toBe(true);
    expect(gatewayB.started).toBe(false);
    expect(getLiveConfig()).toEqual(firstCfg);
    expect(ctx.logger.error).toHaveBeenCalledWith(
      expect.stringContaining("cross-tenant"),
      expect.objectContaining({ boundCompanyId: "co-1", incomingCompanyId: "co-2" }),
    );
  });

  it("claims the company synchronously so two concurrent applyConfig calls for DIFFERENT companies never both bind — the loser is refused before its own secrets even resolve", async () => {
    // Regression test for the race: applyConfig used to only assign
    // boundCompanyId near the end, after two `await`s (secrets.resolve x2,
    // gateway.start()). That let two overlapping calls for different
    // companies both pass the `boundCompanyId` mismatch guard while it was
    // still null, and both proceed to bind/start a gateway.
    //
    // Company A's bot-token secret resolution is held open with a manually
    // controlled promise so A is guaranteed to still be in flight (stuck
    // before its claim would historically have happened) when company B's
    // call is made. Against the pre-fix code this test fails: B is able to
    // race ahead of A, bind, and fully start its own gateway before A ever
    // resumes — confirmed by running this test against the pre-fix
    // implementation (boundCompanyId assigned only at the very end).
    const { applyConfig } = await loadWorker();
    const { ctx } = makeCtx();

    let releaseA: (token: string) => void = () => {};
    const heldBotTokenA = new Promise<string>((resolve) => {
      releaseA = resolve;
    });
    let resolveCallCount = 0;
    (ctx.secrets.resolve as any).mockImplementation(async (ref: string) => {
      resolveCallCount += 1;
      // Only the very first secrets.resolve call (company A's bot token) is
      // held open; every other call (A's app token, and both of B's) resolves
      // immediately, so B is free to race ahead while A is still stuck.
      if (resolveCallCount === 1) return heldBotTokenA;
      return `secret-${ref}`;
    });

    const gatewayA = new FakeGateway();
    const gatewayB = new FakeGateway();

    const pA = applyConfig(ctx, cfg({ companyId: "co-1" }), () => gatewayA);
    // Started while A is still suspended on its held-open secret resolution —
    // this is the overlap the fix must close.
    const pB = applyConfig(ctx, cfg({ companyId: "co-2" }), () => gatewayB);

    const healthB = await pB;
    // The loser must be refused for tenancy — and, crucially, must never
    // have started a gateway for its company.
    expect(healthB.status).toBe("degraded");
    expect(healthB.message).toContain("co-1");
    expect(healthB.message).toContain("co-2");
    expect(gatewayB.started).toBe(false);
    expect(ctx.logger.error).toHaveBeenCalledWith(
      expect.stringContaining("cross-tenant"),
      expect.objectContaining({ boundCompanyId: "co-1", incomingCompanyId: "co-2" }),
    );

    releaseA("secret-ref-bot");
    const healthA = await pA;
    expect(healthA.status).toBe("ok");
    expect(gatewayA.started).toBe(true);
  });

  it("a missing-fields failure on the first bind leaves boundCompanyId unclaimed so a later valid config for a DIFFERENT company can bind", async () => {
    const { applyConfig } = await loadWorker();
    const { ctx } = makeCtx();

    const gatewayA = new FakeGateway();
    const healthA = await applyConfig(ctx, cfg({ companyId: "co-1", slackBotTokenRef: "" }), () => gatewayA);
    expect(healthA.status).toBe("degraded");
    expect(gatewayA.started).toBe(false);

    const gatewayB = new FakeGateway();
    const healthB = await applyConfig(ctx, cfg({ companyId: "co-2" }), () => gatewayB);
    expect(healthB.status).toBe("ok");
    expect(gatewayB.started).toBe(true);
  });

  it("a secret-resolution failure on the first bind leaves boundCompanyId unclaimed so a later valid config for a DIFFERENT company can bind", async () => {
    const { applyConfig } = await loadWorker();
    const { ctx } = makeCtx();

    (ctx.secrets.resolve as any).mockRejectedValueOnce(new Error("secrets disabled"));
    const gatewayA = new FakeGateway();
    const healthA = await applyConfig(ctx, cfg({ companyId: "co-1" }), () => gatewayA);
    expect(healthA.status).toBe("degraded");
    expect(gatewayA.started).toBe(false);

    const gatewayB = new FakeGateway();
    const healthB = await applyConfig(ctx, cfg({ companyId: "co-2" }), () => gatewayB);
    expect(healthB.status).toBe("ok");
    expect(gatewayB.started).toBe(true);
  });

  it("a gateway.start() failure on the first bind leaves boundCompanyId unclaimed so a later valid config for a DIFFERENT company can bind", async () => {
    const { applyConfig } = await loadWorker();
    const { ctx } = makeCtx();

    const gatewayA = new FakeGateway();
    gatewayA.start = async () => {
      throw new Error("socket connect failed");
    };
    await expect(applyConfig(ctx, cfg({ companyId: "co-1" }), () => gatewayA)).rejects.toThrow(
      "socket connect failed",
    );

    const gatewayB = new FakeGateway();
    const healthB = await applyConfig(ctx, cfg({ companyId: "co-2" }), () => gatewayB);
    expect(healthB.status).toBe("ok");
    expect(gatewayB.started).toBe(true);
  });

  it("never calls ctx.config.get during normal operation (helpers.ts intentionally doesn't mock it)", async () => {
    const { applyConfig } = await loadWorker();
    const { ctx } = makeCtx();
    const gateway = new FakeGateway();
    await applyConfig(ctx, cfg(), () => gateway);
    const ts = (Date.now() / 1000).toFixed(6);
    await gateway.emitMessage({ channel: "D1", channelType: "im", user: "U1", text: "hi", ts });
    await gateway.emitCommand({ command: SLASH_COMMAND, text: "help", user: "U1", channel: "C1" });
    // No mock exists for ctx.config.get (see helpers.ts) — if any code path
    // started calling it, it would throw here rather than pass silently.
    expect((ctx as unknown as { config?: unknown }).config).toBeUndefined();
  });
});

describe("access control (allowedSlackUserIds)", () => {
  function accessCfg(overrides: Partial<typeof TEST_CONFIG> = {}) {
    return cfg({ allowedSlackUserIds: ["U-ALLOWED"], ...overrides });
  }

  it("a DM from a denied user produces no session creation, no sendMessage, and no gateway posts", async () => {
    const { applyConfig } = await loadWorker();
    const { ctx } = makeCtx();
    const gateway = new FakeGateway();
    await applyConfig(ctx, accessCfg(), () => gateway);
    const ts = (Date.now() / 1000).toFixed(6);
    await gateway.emitMessage({ channel: "D1", channelType: "im", user: "U-OTHER", text: "hi", ts });
    expect(ctx.agents.sessions.create).not.toHaveBeenCalled();
    expect(ctx.agents.sessions.sendMessage).not.toHaveBeenCalled();
    expect(gateway.posts).toHaveLength(0);
    expect(ctx.logger.info).toHaveBeenCalledWith(
      "Ignoring Slack interaction from a user not on the allowlist",
      expect.objectContaining({ user: "U-OTHER", surface: "message" }),
    );
    expect(ctx.metrics.write).toHaveBeenCalledWith("slack.access.denied", 1, { surface: "message" });
  });

  it("an @mention from a denied user produces no session creation and no gateway posts", async () => {
    const { applyConfig } = await loadWorker();
    const { ctx } = makeCtx();
    const gateway = new FakeGateway();
    await applyConfig(ctx, accessCfg(), () => gateway);
    const ts = (Date.now() / 1000).toFixed(6);
    await gateway.emitMention({
      channel: "C1", channelType: "channel", user: "U-OTHER", text: "<@UBOT> hi", ts,
    });
    expect(ctx.agents.sessions.create).not.toHaveBeenCalled();
    expect(ctx.agents.sessions.sendMessage).not.toHaveBeenCalled();
    expect(gateway.posts).toHaveLength(0);
    expect(ctx.logger.info).toHaveBeenCalledWith(
      "Ignoring Slack interaction from a user not on the allowlist",
      expect.objectContaining({ user: "U-OTHER", surface: "mention" }),
    );
    expect(ctx.metrics.write).toHaveBeenCalledWith("slack.access.denied", 1, { surface: "mention" });
  });

  it("an allowed user's @mention is still handled normally", async () => {
    const { applyConfig } = await loadWorker();
    const { ctx } = makeCtx();
    const gateway = new FakeGateway();
    await applyConfig(ctx, accessCfg(), () => gateway);
    const ts = (Date.now() / 1000).toFixed(6);
    await gateway.emitMention({
      channel: "C1", channelType: "channel", user: "U-ALLOWED", text: "<@UBOT> hi", ts,
    });
    expect(ctx.agents.sessions.create).toHaveBeenCalled();
  });

  it("a slash command from a denied user produces no ephemeral", async () => {
    const { applyConfig } = await loadWorker();
    const { ctx } = makeCtx();
    const gateway = new FakeGateway();
    await applyConfig(ctx, accessCfg(), () => gateway);
    await gateway.emitCommand({ command: SLASH_COMMAND, text: "help", user: "U-OTHER", channel: "C1" });
    expect(gateway.ephemerals).toHaveLength(0);
    expect(ctx.logger.info).toHaveBeenCalledWith(
      "Ignoring Slack interaction from a user not on the allowlist",
      expect.objectContaining({ user: "U-OTHER", surface: "command" }),
    );
    expect(ctx.metrics.write).toHaveBeenCalledWith("slack.access.denied", 1, { surface: "command" });
  });

  it("an approval button action from a denied user produces no ctx.http.fetch call and no message update", async () => {
    const { applyConfig } = await loadWorker();
    const { ctx } = makeCtx();
    const gateway = new FakeGateway();
    await applyConfig(ctx, accessCfg(), () => gateway);
    await gateway.emitAction({
      actionId: "approval_approve",
      value: "appr-1",
      user: "U-OTHER",
      userName: "Other Person",
      channel: "C1",
      messageTs: "10.1",
    });
    expect(ctx.http.fetch).not.toHaveBeenCalled();
    expect(gateway.updates).toHaveLength(0);
    expect(ctx.metrics.write).toHaveBeenCalledWith("slack.access.denied", 1, { surface: "action" });
  });

  it("a reaction from a denied user produces no issues.createComment", async () => {
    const { applyConfig } = await loadWorker();
    const { ctx, stateStore } = makeCtx();
    const gateway = new FakeGateway();
    await applyConfig(ctx, accessCfg(), () => gateway);
    stateStore.set(STATE_KEYS.question("C1", "10.1"), {
      channel: "C1", ts: "10.1", issueId: "iss-1", companyId: "co-1", mode: "reaction",
      question: "Q?", askedAt: new Date().toISOString(), timeoutMinutes: 60,
    });
    await gateway.emitReaction({ channel: "C1", messageTs: "10.1", user: "U-OTHER", reaction: "+1" });
    expect(ctx.issues.createComment).not.toHaveBeenCalled();
    expect(ctx.metrics.write).toHaveBeenCalledWith("slack.access.denied", 1, { surface: "reaction" });
  });

  it("an allowed user still gets normal message-path behavior", async () => {
    const { applyConfig } = await loadWorker();
    const { ctx } = makeCtx();
    const gateway = new FakeGateway();
    await applyConfig(ctx, accessCfg(), () => gateway);
    const ts = (Date.now() / 1000).toFixed(6);
    await gateway.emitMessage({ channel: "D1", channelType: "im", user: "U-ALLOWED", text: "hi", ts });
    expect(ctx.agents.sessions.sendMessage).toHaveBeenCalled();
  });

  it("an allowed user still gets normal command-path behavior", async () => {
    const { applyConfig } = await loadWorker();
    const { ctx } = makeCtx();
    const gateway = new FakeGateway();
    await applyConfig(ctx, accessCfg(), () => gateway);
    await gateway.emitCommand({ command: SLASH_COMMAND, text: "help", user: "U-ALLOWED", channel: "C1" });
    expect(gateway.ephemerals).toHaveLength(1);
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

  it("reports degraded health naming the conflict after a mismatched-company config is refused, while the bound company's gateway keeps running", async () => {
    const { default: plugin } = await loadWorker();
    const { ctx } = makeCtx();
    await plugin.definition.setup(ctx);
    await plugin.definition.onConfigChanged?.(cfg());
    await expect(plugin.definition.onHealth?.()).resolves.toEqual({ status: "ok" });

    await plugin.definition.onConfigChanged?.(cfg({ companyId: "co-2" }));
    const health = await plugin.definition.onHealth?.();
    expect(health?.status).toBe("degraded");
    expect(health?.message).toContain("co-1");
    expect(health?.message).toContain("co-2");
    // The originally-bound company's gateway is untouched: no new BoltGateway
    // was created and the first one is still running.
    expect(boltGatewayInstances).toHaveLength(1);
    expect(boltGatewayInstances[0]!.started).toBe(true);
  });

  it("does not let a stale tenant conflict mask a newer same-company failure", async () => {
    // Regression test: onHealth checks tenantConflict first, and it used to
    // be cleared only on a *successful* apply. So a cross-tenant refusal
    // followed by a same-company config that itself fails validation would
    // still report the stale cross-tenant message instead of the new
    // failure — even though the cross-tenant refusal is old news and the
    // validation failure is what the operator needs to see right now.
    const { default: plugin } = await loadWorker();
    const { ctx } = makeCtx();
    await plugin.definition.setup(ctx);
    await plugin.definition.onConfigChanged?.(cfg());
    await plugin.definition.onConfigChanged?.(cfg({ companyId: "co-2" }));
    await expect(plugin.definition.onHealth?.()).resolves.toMatchObject({
      status: "degraded",
      message: expect.stringContaining("co-2"),
    });

    // A same-company (co-1) config that itself fails validation.
    await plugin.definition.onConfigChanged?.(cfg({ slackBotTokenRef: "" }));
    const health = await plugin.definition.onHealth?.();
    expect(health?.status).toBe("degraded");
    expect(health?.message).toMatch(/missing/i);
    expect(health?.message).not.toContain("co-2");
  });

  it("clears the tenant conflict once a matching-company config re-applies", async () => {
    const { default: plugin } = await loadWorker();
    const { ctx } = makeCtx();
    await plugin.definition.setup(ctx);
    await plugin.definition.onConfigChanged?.(cfg());
    await plugin.definition.onConfigChanged?.(cfg({ companyId: "co-2" }));
    await expect(plugin.definition.onHealth?.()).resolves.toMatchObject({ status: "degraded" });

    await plugin.definition.onConfigChanged?.(cfg({ defaultChannelId: "C-OTHER" }));
    await expect(plugin.definition.onHealth?.()).resolves.toEqual({ status: "ok" });
  });

  it("creates the gateway outside the host invocation context", async () => {
    // Regression test for the bug this branch fixes: Node's AsyncLocalStorage
    // context propagates into anything created inside `als.run(...)`,
    // including sockets, and every later callback from that socket runs in
    // the captured store. The plugin SDK runs a host call carrying a
    // `paperclipInvocation` (like `configChanged`) inside
    // `invocationContextStorage.run(...)`. If the Slack gateway were
    // constructed synchronously inside `onConfigChanged`, it would be built
    // inside that invocation's store, and every later Slack event would echo
    // the id of a `configChanged` invocation the host finished long ago —
    // rejected with "unknown invocation scope".
    //
    // This test uses a real Node AsyncLocalStorage (not a mock of the SDK)
    // to assert the actual invariant: whatever store is active when
    // `onConfigChanged` is called must NOT be the store active when the
    // gateway is constructed.
    const als = new AsyncLocalStorage<{ invocationId: string }>();
    alsCapture.als = als;
    alsCapture.captured = "unset";

    const { default: plugin } = await loadWorker();
    const { ctx } = makeCtx();
    await plugin.definition.setup(ctx);

    await als.run({ invocationId: "configChanged-1" }, async () => {
      await plugin.definition.onConfigChanged!(cfg());
    });

    expect(alsCapture.captured).toBeUndefined();
  });

  it("applies two configs pushed back-to-back in order, and neither deferred host call hangs", async () => {
    const { default: plugin, getLiveConfig } = await loadWorker();
    const { ctx } = makeCtx();
    await plugin.definition.setup(ctx);

    // Deliberately not awaited individually — both host calls are in flight
    // at once, exercising the pump's queue rather than serializing through
    // the test itself.
    const p1 = plugin.definition.onConfigChanged!(cfg());
    const p2 = plugin.definition.onConfigChanged!(cfg({ defaultChannelId: "C-OTHER" }));
    await expect(Promise.all([p1, p2])).resolves.toBeDefined();

    expect(boltGatewayInstances).toHaveLength(2);
    expect(boltGatewayInstances[0]!.started).toBe(false); // torn down by the second apply
    expect(boltGatewayInstances[1]!.started).toBe(true);
    expect(getLiveConfig().defaultChannelId).toBe("C-OTHER");
  });

  it("a config whose apply throws still resolves the host call and leaves health degraded", async () => {
    const { default: plugin } = await loadWorker();
    const { ctx } = makeCtx();
    // Makes the mocked BoltGateway's start() throw — see the sentinel check
    // in the Mock class above. applyConfig only ever throws out of a
    // gateway.start() failure, so this is what drives the pump's catch path.
    (ctx.secrets.resolve as any).mockImplementation(async (ref: string) =>
      ref === "ref-bot" ? "THROW_ON_START" : `secret-${ref}`,
    );
    await plugin.definition.setup(ctx);

    await expect(plugin.definition.onConfigChanged!(cfg())).resolves.toBeUndefined();

    const health = await plugin.definition.onHealth?.();
    expect(health?.status).toBe("degraded");
    expect(health?.message).toMatch(/slack socket configuration failed/i);
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

describe("describeHostError", () => {
  it("explains the save-first ordering when the host denies company context", async () => {
    const { describeHostError } = await import("../src/host-errors.js");
    const message = describeHostError(
      new Error('Plugin "abc" is not allowed to perform "secrets.resolve": company context is required'),
    );
    expect(message).toContain("Save first");
    expect(message).not.toContain("company context is required");
  });

  it("passes other errors through unchanged", async () => {
    const { describeHostError } = await import("../src/host-errors.js");
    expect(describeHostError(new Error("secret not found"))).toContain("secret not found");
  });

  it("redacts tokens in passed-through errors", async () => {
    const { describeHostError } = await import("../src/host-errors.js");
    expect(describeHostError(new Error("bad token xoxb-123-abc"))).not.toContain("xoxb-123-abc");
  });
});

describe("describeHostError — background authorization", () => {
  it("explains that a first-time configuration needs a worker restart", async () => {
    const { describeHostError } = await import("../src/host-errors.js");
    const message = describeHostError(
      new Error(
        'Plugin "abc" is not allowed to perform "agents.sessions.create": the worker referenced a missing, expired, or unknown invocation scope',
      ),
    );
    expect(message).toContain("Disable and re-enable");
    expect(message).not.toContain("invocation scope");
  });
});

describe("socket watchdog", () => {
  it("startSocketWatchdog installs exactly one unref'd 60s interval, however many times it is called", async () => {
    const { startSocketWatchdog } = await loadWorker();
    const { ctx } = makeCtx();
    const unref = vi.fn();
    // No awaits inside the spy window: setInterval is a global vitest itself
    // may use, so it is mocked for as short a stretch as possible.
    const setIntervalSpy = vi
      .spyOn(globalThis, "setInterval")
      .mockImplementation((() => ({ unref })) as any);
    try {
      startSocketWatchdog(ctx);
      startSocketWatchdog(ctx);
      expect(setIntervalSpy).toHaveBeenCalledTimes(1);
      expect(setIntervalSpy.mock.calls[0]![1]).toBe(60_000);
      // Unref'd so a 60s poll can never hold the worker process — or a test
      // run — open.
      expect(unref).toHaveBeenCalledTimes(1);
    } finally {
      setIntervalSpy.mockRestore();
    }
  });

  it("is started by setup(), so a later explicit call is a no-op", async () => {
    const { default: plugin, startSocketWatchdog } = await loadWorker();
    const { ctx } = makeCtx();
    await plugin.definition.setup(ctx);
    const setIntervalSpy = vi.spyOn(globalThis, "setInterval");
    try {
      startSocketWatchdog(ctx);
      expect(setIntervalSpy).not.toHaveBeenCalled();
    } finally {
      setIntervalSpy.mockRestore();
    }
  });

  it("does nothing before any config has applied", async () => {
    const { default: plugin, socketWatchdogTick } = await loadWorker();
    const { ctx } = makeCtx();
    await plugin.definition.setup(ctx);
    await socketWatchdogTick(ctx, 0);
    expect(boltGatewayInstances).toHaveLength(0);
    expect(ctx.metrics.write).not.toHaveBeenCalledWith(
      "slack.socket.recovery.attempted",
      1,
      expect.anything(),
    );
  });

  it("leaves a healthy gateway alone: connected and probing true means no recovery", async () => {
    const { default: plugin, socketWatchdogTick } = await loadWorker();
    const { ctx } = makeCtx();
    await plugin.definition.setup(ctx);
    await plugin.definition.onConfigChanged!(cfg());
    expect(boltGatewayInstances).toHaveLength(1);

    await socketWatchdogTick(ctx, 0);

    expect(boltGatewayInstances).toHaveLength(1);
    expect(ctx.metrics.write).not.toHaveBeenCalledWith(
      "slack.socket.recovery.attempted",
      1,
      expect.anything(),
    );
    await expect(plugin.definition.onHealth?.()).resolves.toEqual({ status: "ok" });
  });

  it("recovers through the config pump — never by calling applyConfig directly — so the new gateway is built outside the tick's ALS store", async () => {
    // THE load-bearing invariant (src/worker.ts's "Config apply pump"
    // comment). A timer callback that called applyConfig itself would
    // construct the Slack gateway inside whatever AsyncLocalStorage store was
    // active, and every later Slack event would echo the id of an invocation
    // the host finished long ago — denied with "unknown invocation scope".
    // Asserting the captured store is undefined is the only way to prove the
    // work actually travelled through applyQueue + signalPump.
    const als = new AsyncLocalStorage<{ invocationId: string }>();
    const { default: plugin, socketWatchdogTick } = await loadWorker();
    const { ctx } = makeCtx();
    await plugin.definition.setup(ctx);
    await plugin.definition.onConfigChanged!(cfg());

    boltGatewayInstances[0]!.started = false; // socket dropped for good
    alsCapture.als = als;
    alsCapture.captured = "unset";

    await als.run({ invocationId: "watchdog-1" }, async () => {
      await socketWatchdogTick(ctx, 0);
    });

    expect(boltGatewayInstances).toHaveLength(2);
    expect(boltGatewayInstances[1]!.started).toBe(true);
    expect(alsCapture.captured).toBeUndefined();
  });

  it("skips while a config apply is queued, so it never races the pump", async () => {
    const { default: plugin, socketWatchdogTick } = await loadWorker();
    const { ctx } = makeCtx();
    await plugin.definition.setup(ctx);
    await plugin.definition.onConfigChanged!(cfg());
    expect(boltGatewayInstances).toHaveLength(1);

    // Park the next apply inside applyConfig's teardown by holding the
    // current gateway's stop() open, leaving a second job sitting in
    // applyQueue with nothing draining it.
    let releaseStop: () => void = () => {};
    (boltGatewayInstances[0] as any).stop = () =>
      new Promise<void>((resolve) => {
        releaseStop = resolve;
      });
    // Dead socket, so the queue guard is the only thing that can stop the
    // watchdog from recovering.
    boltGatewayInstances[0]!.started = false;

    const p1 = plugin.definition.onConfigChanged!(cfg({ defaultChannelId: "C-A" }));
    const p2 = plugin.definition.onConfigChanged!(cfg({ defaultChannelId: "C-B" }));
    // One macrotask is enough: everything between waitForWork() and the held
    // stop() is microtask-only, and the microtask queue drains first.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(boltGatewayInstances).toHaveLength(1); // parked before makeGateway

    await socketWatchdogTick(ctx, 0);

    expect(ctx.metrics.write).not.toHaveBeenCalledWith(
      "slack.socket.recovery.attempted",
      1,
      expect.anything(),
    );

    releaseStop();
    await Promise.all([p1, p2]);
  });

  it("recovers a gateway that still claims isConnected() but fails its probe", async () => {
    const { default: plugin, socketWatchdogTick } = await loadWorker();
    const { ctx } = makeCtx();
    await plugin.definition.setup(ctx);
    await plugin.definition.onConfigChanged!(cfg());

    // Token revoked underneath a socket Bolt still believes is open: the
    // liveness check must not rest on isConnected() alone.
    boltGatewayInstances[0]!.probeResult = false;
    expect(boltGatewayInstances[0]!.started).toBe(true);

    await socketWatchdogTick(ctx, 0);

    expect(boltGatewayInstances).toHaveLength(2);
    expect(boltGatewayInstances[1]!.started).toBe(true);
    expect(ctx.metrics.write).toHaveBeenCalledWith("slack.socket.recovery.attempted", 1, { attempt: "1" });
    expect(ctx.metrics.write).toHaveBeenCalledWith("slack.socket.recovery.succeeded", 1, { attempt: "1" });
  });

  it("recovers from a failed gateway.start(), where currentGateway holds a dead but NON-NULL gateway", async () => {
    const { default: plugin, socketWatchdogTick } = await loadWorker();
    const { ctx } = makeCtx();
    (ctx.secrets.resolve as any).mockImplementation(async (ref: string) =>
      ref === "ref-bot" ? "THROW_ON_START" : `secret-${ref}`,
    );
    await plugin.definition.setup(ctx);
    await plugin.definition.onConfigChanged!(cfg());

    // currentGateway was assigned before the try/catch around start(), so a
    // "is there a gateway at all?" check would wrongly call this healthy.
    expect(boltGatewayInstances).toHaveLength(1);
    expect(boltGatewayInstances[0]!.started).toBe(false);
    await expect(plugin.definition.onHealth?.()).resolves.toMatchObject({ status: "degraded" });

    // That failure rolled the claim back (didClaim); the recovering apply
    // simply re-claims boundCompanyId, which is correct.
    (ctx.secrets.resolve as any).mockImplementation(async (ref: string) => `secret-${ref}`);
    await socketWatchdogTick(ctx, 0);

    expect(boltGatewayInstances).toHaveLength(2);
    expect(boltGatewayInstances[1]!.started).toBe(true);
    expect(ctx.metrics.write).toHaveBeenCalledWith("slack.socket.recovery.succeeded", 1, { attempt: "1" });
    await expect(plugin.definition.onHealth?.()).resolves.toEqual({ status: "ok" });
  });

  it("escalates the backoff on repeated failures, reports the attempt in onHealth, and resets once recovery succeeds", async () => {
    const { default: plugin, socketWatchdogTick } = await loadWorker();
    const { ctx } = makeCtx();
    (ctx.secrets.resolve as any).mockImplementation(async (ref: string) =>
      ref === "ref-bot" ? "THROW_ON_START" : `secret-${ref}`,
    );
    await plugin.definition.setup(ctx);
    await plugin.definition.onConfigChanged!(cfg());
    expect(boltGatewayInstances).toHaveLength(1);

    // Attempt 1 fails -> next attempt no earlier than now + 1m.
    await socketWatchdogTick(ctx, 0);
    expect(ctx.metrics.write).toHaveBeenCalledWith("slack.socket.recovery.attempted", 1, { attempt: "1" });
    expect(ctx.metrics.write).toHaveBeenCalledWith("slack.socket.recovery.failed", 1, { attempt: "1" });
    expect(boltGatewayInstances).toHaveLength(2);

    await socketWatchdogTick(ctx, 59_999); // still inside the 1m backoff
    expect(boltGatewayInstances).toHaveLength(2);

    // Attempt 2 fails -> next attempt no earlier than 60_000 + 2m.
    await socketWatchdogTick(ctx, 60_000);
    expect(ctx.metrics.write).toHaveBeenCalledWith("slack.socket.recovery.attempted", 1, { attempt: "2" });
    expect(boltGatewayInstances).toHaveLength(3);

    await socketWatchdogTick(ctx, 179_999); // still inside the 2m backoff
    expect(boltGatewayInstances).toHaveLength(3);

    await expect(plugin.definition.onHealth?.()).resolves.toEqual({
      status: "degraded",
      message: "Slack Socket Mode disconnected; recovery attempt 2",
    });

    // Token fixed: re-applying re-resolves both secret refs, so attempt 3
    // succeeds without an operator save, and the backoff resets.
    (ctx.secrets.resolve as any).mockImplementation(async (ref: string) => `secret-${ref}`);
    await socketWatchdogTick(ctx, 180_000);
    expect(ctx.metrics.write).toHaveBeenCalledWith("slack.socket.recovery.succeeded", 1, { attempt: "3" });
    expect(boltGatewayInstances).toHaveLength(4);
    expect(boltGatewayInstances[3]!.started).toBe(true);
    await expect(plugin.definition.onHealth?.()).resolves.toEqual({ status: "ok" });
  });

  it("resets the watchdog's recovery counters on a successful applyConfig, so onHealth reports ok right away instead of waiting out the backoff deadline", async () => {
    // The bug: recoveryAttempts/recoveryNotBefore were only ever reset by a
    // watchdog TICK's own success branch, never by applyConfig's success
    // tail. So an operator who fixes a revoked token with a normal save
    // (onConfigChanged, not a tick) got a socket that was fully back up —
    // but onHealth still reported "recovery attempt N" for up to another 15
    // minutes, until the next tick happened to land and re-succeed.
    const { default: plugin, socketWatchdogTick } = await loadWorker();
    const { ctx } = makeCtx();
    (ctx.secrets.resolve as any).mockImplementation(async (ref: string) =>
      ref === "ref-bot" ? "THROW_ON_START" : `secret-${ref}`,
    );
    await plugin.definition.setup(ctx);
    await plugin.definition.onConfigChanged!(cfg());
    expect(boltGatewayInstances).toHaveLength(1);

    // A failed watchdog recovery attempt increments recoveryAttempts and
    // pushes recoveryNotBefore out ~1 minute.
    await socketWatchdogTick(ctx, 0);
    await expect(plugin.definition.onHealth?.()).resolves.toEqual({
      status: "degraded",
      message: "Slack Socket Mode disconnected; recovery attempt 1",
    });

    // The operator rotates the secret and saves — a normal onConfigChanged
    // call, deliberately NOT another watchdog tick, so this only exercises
    // applyConfig's own success path.
    (ctx.secrets.resolve as any).mockImplementation(async (ref: string) => `secret-${ref}`);
    await plugin.definition.onConfigChanged!(cfg({ defaultChannelId: "C-FIXED" }));

    await expect(plugin.definition.onHealth?.()).resolves.toEqual({ status: "ok" });
  });

  it("recoveryInFlight blocks a second, concurrent tick from ever touching probe() while the first is still parked there", async () => {
    // Nothing else pins this guard: deleting it leaves every other worker
    // test green, even though its failure mode is two overlapping recovery
    // attempts. Proven directly here by counting probe() calls rather than
    // relying on a side effect that a different bug could also produce.
    const { default: plugin, socketWatchdogTick } = await loadWorker();
    const { ctx } = makeCtx();
    await plugin.definition.setup(ctx);
    await plugin.definition.onConfigChanged!(cfg());
    expect(boltGatewayInstances).toHaveLength(1);

    let probeCalls = 0;
    let resolveProbe: (v: boolean) => void = () => {};
    (boltGatewayInstances[0] as any).probe = () => {
      probeCalls += 1;
      return new Promise<boolean>((resolve) => {
        resolveProbe = resolve;
      });
    };

    // Calling (without awaiting) an async function runs it synchronously up
    // to its first await, so tick1 has already reached — and called — the
    // held probe() above by the time this line returns.
    const tick1 = socketWatchdogTick(ctx, 0);
    expect(probeCalls).toBe(1);

    const tick2 = socketWatchdogTick(ctx, 0);
    await tick2;
    expect(probeCalls).toBe(1); // tick2 never called probe(): the guard turned it away immediately

    resolveProbe(false);
    await tick1;

    expect(boltGatewayInstances).toHaveLength(2); // tick1 alone completed the recovery
    expect(ctx.metrics.write).toHaveBeenCalledWith("slack.socket.recovery.attempted", 1, { attempt: "1" });
  });

  it("a hanging probe times out instead of wedging recoveryInFlight shut, and the watchdog can still recover afterward", async () => {
    // The Critical this pins: BoltGateway.probe() is a plain auth.test()
    // call, and Bolt's App is constructed with no clientOptions, so the
    // underlying WebClient defaults to timeout: 0 (no per-request abort)
    // plus Slack's ~10-retries-over-~30-minutes retry policy — exactly the
    // shape a revoked/rotated token produces. An unbounded
    // `await gateway.probe()` would suspend this tick forever; since control
    // never returns to it, the `finally { recoveryInFlight = false }` in
    // socketWatchdogTick would never run either, wedging every later tick
    // shut while onHealth kept reporting "ok".
    vi.useFakeTimers();
    const { default: plugin, socketWatchdogTick } = await loadWorker();
    const { ctx } = makeCtx();
    await plugin.definition.setup(ctx);
    await plugin.definition.onConfigChanged!(cfg());
    expect(boltGatewayInstances).toHaveLength(1);

    (boltGatewayInstances[0] as any).probe = () => new Promise<boolean>(() => {}); // never settles

    const tick = socketWatchdogTick(ctx, 0);
    await vi.advanceTimersByTimeAsync(10_000); // the watchdog's own probe bound
    await tick;

    expect(boltGatewayInstances).toHaveLength(2); // recovered despite the hang
    expect(boltGatewayInstances[1]!.started).toBe(true);
    expect(ctx.metrics.write).toHaveBeenCalledWith("slack.socket.recovery.succeeded", 1, { attempt: "1" });

    // Not wedged: recoveryInFlight was cleared, so a fully independent later
    // tick can still run and recover a second time.
    boltGatewayInstances[1]!.started = false;
    await socketWatchdogTick(ctx, 60_000);
    expect(boltGatewayInstances).toHaveLength(3);
    expect(boltGatewayInstances[2]!.started).toBe(true);
  });

  it("does not revert a config save that completes while a recovery tick is still probing", async () => {
    // The first Important this pins: the tick used to capture
    // `cfg = liveConfig` once, up front, and re-enqueue that stale capture
    // after awaiting the probe — clobbering any operator save that landed
    // and finished in the meantime, including access-widening fields like
    // allowedSlackUserIds/agentPostChannelIds/agentPostMessageEnabled.
    const { default: plugin, socketWatchdogTick, getLiveConfig } = await loadWorker();
    const { ctx } = makeCtx();
    await plugin.definition.setup(ctx);
    await plugin.definition.onConfigChanged!(cfg({ defaultChannelId: "C-V1" }));
    expect(getLiveConfig().defaultChannelId).toBe("C-V1");

    let resolveProbe: (v: boolean) => void = () => {};
    (boltGatewayInstances[0] as any).probe = () =>
      new Promise<boolean>((resolve) => {
        resolveProbe = resolve;
      });

    const tick = socketWatchdogTick(ctx, 0);

    // The operator's own save lands and fully completes — through the same
    // applyQueue + signalPump pump — while the tick above is still parked
    // awaiting its probe. This doesn't race `recoveryInFlight`, which only
    // guards socketWatchdogTick's own re-entrancy, not onConfigChanged.
    await plugin.definition.onConfigChanged!(cfg({ defaultChannelId: "C-V2" }));
    expect(getLiveConfig().defaultChannelId).toBe("C-V2");

    // Now let the stale tick's probe resolve "not alive". With the fix, it
    // re-reads liveConfig immediately before enqueueing instead of reusing
    // the "C-V1" value captured before the probe, so it must not revert the
    // save that already landed.
    resolveProbe(false);
    await tick;

    expect(getLiveConfig().defaultChannelId).toBe("C-V2");
  });

  it("stands down while an apply is in flight, even though applyQueue reads empty for its whole duration", async () => {
    // The second Important this pins: the pump shift()s a job off
    // applyQueue before awaiting applyConfig, so applyQueue.length alone
    // reads 0 for the entire apply. This test isolates the exact window the
    // reviewer demonstrated: currentGateway is the NEW, non-null gateway,
    // legitimately mid-handshake (isConnected() still false because its
    // start() hasn't resolved yet) — not the pre-existing "skips while a
    // config apply is queued" test above, which hangs the OLD gateway's
    // stop() instead, so currentGateway there is still the previous,
    // already-connected gateway and never exercises this branch at all.
    const { default: plugin, socketWatchdogTick } = await loadWorker();
    const { ctx } = makeCtx();
    await plugin.definition.setup(ctx);
    await plugin.definition.onConfigChanged!(cfg());
    expect(boltGatewayInstances).toHaveLength(1);

    // Patch the mock's shared start() so the *next* constructed instance's
    // handshake hangs. Restored in `finally` — this prototype is shared by
    // every BoltGateway instance across the whole test file via vi.hoisted,
    // so leaving it patched would silently break later tests.
    const originalStart = BoltGatewayMock.prototype.start;
    let releaseStart: () => void = () => {};
    BoltGatewayMock.prototype.start = function (this: { started: boolean }) {
      return new Promise<void>((resolve) => {
        releaseStart = () => {
          this.started = true;
          resolve();
        };
      });
    };

    try {
      const applyPromise = plugin.definition.onConfigChanged!(cfg({ defaultChannelId: "C-A" }));
      // One macrotask is enough: everything between waitForWork() and the
      // held start() is microtask-only, and the microtask queue drains first.
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(boltGatewayInstances).toHaveLength(2); // the new gateway now exists...
      expect(boltGatewayInstances[1]!.started).toBe(false); // ...but hasn't finished starting
      // applyQueue is already empty at this point — only applyInFlight can
      // still tell the watchdog an apply is genuinely in progress.

      await socketWatchdogTick(ctx, 0);

      expect(ctx.metrics.write).not.toHaveBeenCalledWith(
        "slack.socket.recovery.attempted",
        1,
        expect.anything(),
      );
      expect(boltGatewayInstances).toHaveLength(2); // the watchdog did not pile a third gateway on top

      releaseStart();
      await applyPromise;
      expect(boltGatewayInstances[1]!.started).toBe(true);
    } finally {
      BoltGatewayMock.prototype.start = originalStart;
    }
  });
});
