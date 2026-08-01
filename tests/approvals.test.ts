import { describe, expect, it } from "vitest";
import { createApprovals } from "../src/approvals.js";
import { ACTION_IDS } from "../src/constants.js";
import { loadConfig } from "../src/config.js";
import { FakeGateway, makeCtx } from "./helpers.js";

function setup(configOverrides = {}) {
  const bundle = makeCtx(configOverrides);
  const gateway = new FakeGateway();
  const approvals = createApprovals({ ctx: bundle.ctx, gateway, getConfig: () => loadConfig(bundle.ctx) });
  return { ...bundle, gateway, approvals };
}

const approveAction = {
  actionId: ACTION_IDS.approvalApprove,
  value: "app-1",
  user: "U9",
  userName: "sam",
  channel: "C-APPR",
  messageTs: "77.1",
};

describe("approvals", () => {
  it("posts approval.created with buttons to the approvals channel", async () => {
    const { gateway, emitEvent } = setup({ approvalsChannelId: "C-APPR" });
    await emitEvent("approval.created", { entityId: "app-1", payload: { title: "Deploy?" } });
    expect(gateway.posts[0]!.channel).toBe("C-APPR");
    expect(JSON.stringify(gateway.posts[0]!.blocks)).toContain(ACTION_IDS.approvalApprove);
  });

  it("decides the approval and updates the message on approve", async () => {
    const { ctx, gateway, approvals } = setup();
    await approvals.handleAction(approveAction);
    expect(ctx.approvals.decide).toHaveBeenCalledWith(
      "app-1",
      expect.objectContaining({ action: "approve", decisionNote: expect.stringContaining("sam") }),
      "co-1",
    );
    expect(gateway.updates[0]!.ts).toBe("77.1");
    expect(gateway.updates[0]!.text).toContain("Approved");
    expect(ctx.activity.log).toHaveBeenCalled();
  });

  it("maps the reject action id to a reject decision", async () => {
    const { ctx, approvals } = setup();
    await approvals.handleAction({ ...approveAction, actionId: ACTION_IDS.approvalReject });
    expect(ctx.approvals.decide).toHaveBeenCalledWith(
      "app-1",
      expect.objectContaining({ action: "reject" }),
      "co-1",
    );
  });

  it("posts an ephemeral failure note when decide throws", async () => {
    const { ctx, gateway, approvals } = setup();
    (ctx.approvals.decide as any).mockRejectedValueOnce(new Error("already decided"));
    await approvals.handleAction(approveAction);
    expect(gateway.updates).toHaveLength(0);
    expect(gateway.ephemerals[0]!.user).toBe("U9");
  });
});
