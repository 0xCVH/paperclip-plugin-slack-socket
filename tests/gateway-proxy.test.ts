import { describe, expect, it, vi } from "vitest";
import { createGatewayProxy } from "../src/gateway-proxy.js";
import type { SlackGateway } from "../src/types.js";
import { FakeGateway } from "./helpers.js";

function makeLogger() {
  return { warn: vi.fn() };
}

describe("createGatewayProxy", () => {
  it("delegates every call to the live gateway when one exists", async () => {
    const real = new FakeGateway();
    const logger = makeLogger();
    const proxy = createGatewayProxy(() => real, logger);

    await proxy.start();
    expect(real.started).toBe(true);
    expect(proxy.isConnected()).toBe(true);
    expect(proxy.botUserId()).toBe("UBOT");

    const posted = await proxy.postMessage({ channel: "C1", text: "hi" });
    expect(real.posts).toHaveLength(1);
    expect(posted.channel).toBe("C1");

    await proxy.updateMessage({ channel: "C1", ts: posted.ts, text: "edited" });
    expect(real.updates).toHaveLength(1);

    await proxy.postEphemeral({ channel: "C1", user: "U1", text: "eph" });
    expect(real.ephemerals).toHaveLength(1);

    const dm = await proxy.openDm("U1");
    expect(dm).toBe("D-U1");
    expect(real.dmOpens).toEqual(["U1"]);

    const name = await proxy.getUserDisplayName("U1");
    expect(name).toBe("name-U1");

    const messageHandler = vi.fn(async () => {});
    proxy.onMessage(messageHandler);
    await real.emitMessage({ channel: "C1", channelType: "channel", user: "U1", text: "hi", ts: "1.1" });
    expect(messageHandler).toHaveBeenCalledTimes(1);

    await proxy.stop();
    expect(real.started).toBe(false);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it("no-ops and logs a warning for void/boolean-returning methods when there is no live gateway", async () => {
    const logger = makeLogger();
    const proxy = createGatewayProxy(() => null, logger);

    await expect(proxy.start()).resolves.toBeUndefined();
    await expect(proxy.stop()).resolves.toBeUndefined();
    expect(proxy.isConnected()).toBe(false);
    expect(proxy.botUserId()).toBeUndefined();
    await expect(proxy.updateMessage({ channel: "C1", ts: "1", text: "x" })).resolves.toBeUndefined();
    await expect(proxy.postEphemeral({ channel: "C1", user: "U1", text: "x" })).resolves.toBeUndefined();

    const name = await proxy.getUserDisplayName("U1");
    expect(name).toBe("U1"); // falls back to the id, matching BoltGateway's own fallback

    proxy.onMessage(vi.fn());
    proxy.onMention(vi.fn());
    proxy.onReaction(vi.fn());
    proxy.onAction(/x/, vi.fn());
    proxy.onCommand("/x", vi.fn());

    expect(logger.warn).toHaveBeenCalled();
    expect(logger.warn.mock.calls.length).toBeGreaterThanOrEqual(9);
  });

  it("throws a clear error from postMessage when there is no live gateway, since callers use its return value", async () => {
    const logger = makeLogger();
    const proxy = createGatewayProxy(() => null, logger);
    await expect(proxy.postMessage({ channel: "C1", text: "hi" })).rejects.toThrow(/not configured/i);
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("postMessage"), expect.anything());
  });

  it("reflects gateway swaps made through getGateway between calls", async () => {
    let current: SlackGateway | null = null;
    const proxy = createGatewayProxy(() => current, makeLogger());
    expect(proxy.isConnected()).toBe(false);

    const gw = new FakeGateway();
    await gw.start();
    current = gw;
    expect(proxy.isConnected()).toBe(true);
    expect(proxy.botUserId()).toBe("UBOT");

    current = null;
    expect(proxy.isConnected()).toBe(false);
  });
});
