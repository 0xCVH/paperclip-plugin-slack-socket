import { describe, expect, it } from "vitest";
import { registerNotifications } from "../src/notifications.js";
import { loadConfig } from "../src/config.js";
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
});
