import { describe, expect, it } from "vitest";
import { FakeGateway, makeCtx } from "./helpers.js";
import { stateScope } from "../src/constants.js";

describe("helpers", () => {
  it("FakeGateway records posts with incrementing ts", async () => {
    const gw = new FakeGateway();
    const first = await gw.postMessage({ channel: "C1", text: "a" });
    const second = await gw.postMessage({ channel: "C1", text: "b" });
    expect(first.ts).not.toEqual(second.ts);
    expect(gw.posts).toHaveLength(2);
  });

  it("makeCtx state round-trips through stateScope keys", async () => {
    const { ctx, stateStore } = makeCtx();
    await ctx.state.set(stateScope("k1"), { v: 1 });
    expect(await ctx.state.get(stateScope("k1"))).toEqual({ v: 1 });
    expect(stateStore.get("k1")).toEqual({ v: 1 });
  });

  it("emitEvent drives handlers registered via ctx.events.on", async () => {
    const { ctx, emitEvent } = makeCtx();
    let seen: unknown = null;
    ctx.events.on("issue.created", async (event) => { seen = event; });
    await emitEvent("issue.created", { entityId: "i1" });
    expect(seen).toEqual({ entityId: "i1" });
  });
});
