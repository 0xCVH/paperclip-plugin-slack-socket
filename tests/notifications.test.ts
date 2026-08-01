import { describe, expect, it } from "vitest";
import { registerNotifications } from "../src/notifications.js";
import { loadConfig } from "../src/config.js";
import { STATE_KEYS } from "../src/constants.js";
import { FakeGateway, makeCtx } from "./helpers.js";

function setup(configOverrides = {}) {
  const bundle = makeCtx(configOverrides);
  const gateway = new FakeGateway();
  registerNotifications({ ctx: bundle.ctx, gateway, getConfig: () => loadConfig(bundle.ctx) });
  return { ...bundle, gateway };
}

describe("notifications", () => {
  it("posts issue.created to the default channel", async () => {
    const { gateway, emitEvent } = setup();
    await emitEvent("issue.created", { entityId: "iss-1", payload: { title: "T", status: "todo" } });
    expect(gateway.posts).toHaveLength(1);
    expect(gateway.posts[0]!.channel).toBe("C-DEFAULT");
  });

  it("respects the per-type channel override", async () => {
    const { gateway, emitEvent } = setup({ issuesChannelId: "C-ISSUES" });
    await emitEvent("issue.created", { entityId: "iss-1", payload: { title: "T" } });
    expect(gateway.posts[0]!.channel).toBe("C-ISSUES");
  });

  it("stays silent when the toggle is off", async () => {
    const { gateway, emitEvent } = setup({ notifyOnIssueCreated: false });
    await emitEvent("issue.created", { entityId: "iss-1", payload: { title: "T" } });
    expect(gateway.posts).toHaveLength(0);
  });

  it("only notifies issue.updated when status is done", async () => {
    const { gateway, emitEvent } = setup();
    await emitEvent("issue.updated", { entityId: "iss-1", payload: { status: "in_progress" } });
    expect(gateway.posts).toHaveLength(0);
    await emitEvent("issue.updated", { entityId: "iss-1", payload: { status: "done", title: "T" } });
    expect(gateway.posts).toHaveLength(1);
  });

  it("posts agent.run.failed to the errors channel override", async () => {
    const { gateway, emitEvent } = setup({ errorsChannelId: "C-ERR" });
    await emitEvent("agent.run.failed", { entityId: "run-1", payload: { error: "boom" } });
    expect(gateway.posts[0]!.channel).toBe("C-ERR");
  });

  it("writes a sent metric on successful post and a failed metric when postMessage throws", async () => {
    const { ctx, gateway, emitEvent } = setup();
    await emitEvent("issue.created", { entityId: "iss-1", payload: { title: "T" } });
    expect(ctx.metrics.write).toHaveBeenCalledWith("slack.notifications.sent", 1, { type: "issue_created" });

    gateway.postMessage = async () => {
      throw new Error("slack down");
    };
    await emitEvent("agent.run.failed", { entityId: "run-1", payload: { error: "boom" } });
    expect(ctx.metrics.write).toHaveBeenCalledWith("slack.notifications.failed", 1, { type: "agent_run_failed" });
  });

  it("links issue.created -> issue.updated(done) as a threaded reply and cleans up the thread-link state", async () => {
    const { stateStore, gateway, emitEvent } = setup();
    await emitEvent("issue.created", { entityId: "iss-1", payload: { title: "T" } });
    const createdTs = gateway.posts[0]!.ts;
    const key = STATE_KEYS.issueThread("iss-1");
    expect(stateStore.get(key)).toMatchObject({ channel: "C-DEFAULT", ts: createdTs });
    expect(stateStore.get(STATE_KEYS.issueThreadIndex)).toContain(key);

    await emitEvent("issue.updated", { entityId: "iss-1", payload: { status: "done", title: "T" } });
    expect(gateway.posts).toHaveLength(2);
    expect(gateway.posts[1]!.threadTs).toBe(createdTs);

    // Issue finished: the thread-link entry and its index reference are gone.
    expect(stateStore.get(key)).toBeUndefined();
    expect(stateStore.get(STATE_KEYS.issueThreadIndex)).toEqual([]);
  });

  it("posts issue.updated(done) top-level when no thread-link entry was stored", async () => {
    const { gateway, emitEvent } = setup();
    await emitEvent("issue.updated", { entityId: "iss-2", payload: { status: "done", title: "T" } });
    expect(gateway.posts).toHaveLength(1);
    expect(gateway.posts[0]!.threadTs).toBeUndefined();
  });

  it("posts issue.updated(done) top-level when the stored entry's channel differs from the resolved channel", async () => {
    const { stateStore, gateway, emitEvent } = setup({ issuesChannelId: "C-ISSUES" });
    const key = STATE_KEYS.issueThread("iss-3");
    stateStore.set(key, { channel: "C-OTHER", ts: "111.1", createdAt: new Date().toISOString() });
    stateStore.set(STATE_KEYS.issueThreadIndex, [key]);

    await emitEvent("issue.updated", { entityId: "iss-3", payload: { status: "done", title: "T" } });
    expect(gateway.posts[0]!.channel).toBe("C-ISSUES");
    expect(gateway.posts[0]!.threadTs).toBeUndefined();
    // Mismatched-channel entry is left alone (not the finished-issue case).
    expect(stateStore.get(key)).toBeTruthy();
  });
});
