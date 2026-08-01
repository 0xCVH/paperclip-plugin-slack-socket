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

  it("decides the approval via REST and updates the message on approve", async () => {
    const { ctx, gateway, approvals } = setup();
    await approvals.handleAction(approveAction);
    expect(ctx.http.fetch).toHaveBeenCalledWith(
      "https://pc.example/api/approvals/app-1/approve",
      expect.objectContaining({
        method: "POST",
        body: expect.stringContaining("slack:U9"),
      }),
    );
    expect(gateway.updates[0]!.ts).toBe("77.1");
    expect(gateway.updates[0]!.text).toContain("Approved");
    expect(ctx.activity.log).toHaveBeenCalled();
  });

  it("sends decisionNote (not decidedByUserId) in the request body — the server ignores decidedByUserId", async () => {
    const { ctx, approvals } = setup();
    await approvals.handleAction(approveAction);
    const call = (ctx.http.fetch as any).mock.calls[0];
    const body = JSON.parse(call[1].body);
    expect(body).toEqual({ decisionNote: "Decided via Slack by sam (slack:U9)" });
  });

  it("omits the Authorization header when paperclipApiKeyRef is not configured (local_trusted mode)", async () => {
    const { ctx, approvals } = setup();
    await approvals.handleAction(approveAction);
    const call = (ctx.http.fetch as any).mock.calls[0];
    expect(call[1].headers).not.toHaveProperty("Authorization");
  });

  it("resolves paperclipApiKeyRef and sends it as a Bearer Authorization header when configured", async () => {
    const { ctx, approvals } = setup({ paperclipApiKeyRef: "board-key-ref" });
    await approvals.handleAction(approveAction);
    expect(ctx.secrets.resolve).toHaveBeenCalledWith("board-key-ref");
    const call = (ctx.http.fetch as any).mock.calls[0];
    expect(call[1].headers).toMatchObject({ Authorization: "Bearer secret-board-key-ref" });
  });

  it("treats a failure to resolve the board API key like a REST failure: logs, ephemeral, no update, no REST call", async () => {
    const { ctx, gateway, approvals } = setup({ paperclipApiKeyRef: "board-key-ref" });
    (ctx.secrets.resolve as any).mockRejectedValueOnce(new Error("secret gone"));
    await approvals.handleAction(approveAction);
    expect(ctx.http.fetch).not.toHaveBeenCalled();
    expect(gateway.updates).toHaveLength(0);
    expect(gateway.ephemerals).toHaveLength(1);
    expect(ctx.logger.warn).toHaveBeenCalled();
  });

  it("logs a warning and posts an ephemeral without calling REST when action.value is empty", async () => {
    const { ctx, gateway, approvals } = setup();
    await approvals.handleAction({ ...approveAction, value: "" });
    expect(ctx.http.fetch).not.toHaveBeenCalled();
    expect(gateway.ephemerals).toHaveLength(1);
    expect(ctx.logger.warn).toHaveBeenCalled();
  });

  it("maps the reject action id to the reject endpoint", async () => {
    const { ctx, approvals } = setup();
    await approvals.handleAction({ ...approveAction, actionId: ACTION_IDS.approvalReject });
    expect(ctx.http.fetch).toHaveBeenCalledWith(
      "https://pc.example/api/approvals/app-1/reject",
      expect.anything(),
    );
  });

  it("posts an ephemeral failure note when the REST call fails", async () => {
    const { ctx, gateway, approvals } = setup();
    (ctx.http.fetch as any).mockResolvedValueOnce({ status: 500, json: async () => ({}) });
    await approvals.handleAction(approveAction);
    expect(gateway.updates).toHaveLength(0);
    expect(gateway.ephemerals[0]!.user).toBe("U9");
  });
});
