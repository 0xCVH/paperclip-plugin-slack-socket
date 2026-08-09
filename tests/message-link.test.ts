import { describe, expect, it } from "vitest";
import { getMessageLink, linkMessage, pruneMessageLinks, unlinkMessage } from "../src/message-link.js";
import type { MessageLink } from "../src/types.js";
import { makeCtx } from "./helpers.js";

const DAYS = 24 * 3_600_000;

describe("message-link", () => {
  it("linkMessage stores the link and adds its key to the index", async () => {
    const { ctx, stateStore } = makeCtx();

    await linkMessage(ctx, "link-index-a", "link:e-1", { channel: "C1", ts: "1.1" });

    expect(stateStore.get("link:e-1")).toMatchObject({ channel: "C1", ts: "1.1" });
    expect(stateStore.get("link-index-a")).toEqual(["link:e-1"]);
  });

  it("linkMessage stamps createdAt as an ISO 8601 instant", async () => {
    const { ctx, stateStore } = makeCtx();
    const before = Date.now();

    await linkMessage(ctx, "link-index-b", "link:e-1", { channel: "C1", ts: "1.1" });

    const entry = stateStore.get("link:e-1") as MessageLink;
    expect(entry.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T.*Z$/);
    expect(Date.parse(entry.createdAt)).toBeGreaterThanOrEqual(before - 1);
    expect(Date.parse(entry.createdAt)).toBeLessThanOrEqual(Date.now() + 1);
  });

  it("linkMessage does not duplicate a key already in the index", async () => {
    const { ctx, stateStore } = makeCtx();

    await linkMessage(ctx, "link-index-c", "link:e-1", { channel: "C1", ts: "1.1" });
    await linkMessage(ctx, "link-index-c", "link:e-1", { channel: "C1", ts: "2.2" });

    expect(stateStore.get("link-index-c")).toEqual(["link:e-1"]);
    // The newer post wins — the entity now lives at a different message.
    expect(stateStore.get("link:e-1")).toMatchObject({ ts: "2.2" });
  });

  it("serializes concurrent index appends so neither is lost", async () => {
    const { ctx, stateStore } = makeCtx();

    await Promise.all([
      linkMessage(ctx, "link-index-d", "link:e-1", { channel: "C1", ts: "1.1" }),
      linkMessage(ctx, "link-index-d", "link:e-2", { channel: "C1", ts: "2.1" }),
    ]);

    // A naive read-modify-write would lose one of the two appends; going
    // through updateIndex is what makes this hold.
    expect(stateStore.get("link-index-d")).toEqual(expect.arrayContaining(["link:e-1", "link:e-2"]));
    expect(stateStore.get("link-index-d") as string[]).toHaveLength(2);
  });

  it("getMessageLink returns null when nothing is linked", async () => {
    const { ctx } = makeCtx();

    expect(await getMessageLink(ctx, "link:missing")).toBeNull();
  });

  it("getMessageLink round-trips what linkMessage wrote", async () => {
    const { ctx } = makeCtx();

    await linkMessage(ctx, "link-index-e", "link:e-1", { channel: "C-APPR", ts: "77.1" });

    expect(await getMessageLink(ctx, "link:e-1")).toMatchObject({ channel: "C-APPR", ts: "77.1" });
  });

  it("unlinkMessage deletes the link and removes only its own index key", async () => {
    const { ctx, stateStore } = makeCtx();
    await linkMessage(ctx, "link-index-f", "link:e-1", { channel: "C1", ts: "1.1" });
    await linkMessage(ctx, "link-index-f", "link:e-2", { channel: "C1", ts: "2.1" });

    await unlinkMessage(ctx, "link-index-f", "link:e-1");

    expect(stateStore.get("link:e-1")).toBeUndefined();
    expect(stateStore.get("link:e-2")).toBeTruthy();
    expect(stateStore.get("link-index-f")).toEqual(["link:e-2"]);
  });

  it("unlinkMessage on an unknown key leaves the index intact", async () => {
    const { ctx, stateStore } = makeCtx();
    await linkMessage(ctx, "link-index-g", "link:e-1", { channel: "C1", ts: "1.1" });

    await unlinkMessage(ctx, "link-index-g", "link:e-gone");

    expect(stateStore.get("link-index-g")).toEqual(["link:e-1"]);
  });

  it("pruneMessageLinks deletes links older than maxAgeMs and keeps fresh ones", async () => {
    const { ctx, stateStore } = makeCtx();
    const now = Date.now();
    const stale: MessageLink = { channel: "C1", ts: "1.1", createdAt: new Date(now - 31 * DAYS).toISOString() };
    const fresh: MessageLink = { channel: "C1", ts: "2.1", createdAt: new Date(now - 1 * DAYS).toISOString() };
    stateStore.set("link:stale", stale);
    stateStore.set("link:fresh", fresh);
    stateStore.set("link-index-h", ["link:stale", "link:fresh"]);

    await pruneMessageLinks(ctx, "link-index-h", 30 * DAYS, now);

    expect(stateStore.get("link:stale")).toBeUndefined();
    expect(stateStore.get("link:fresh")).toEqual(fresh);
    expect(stateStore.get("link-index-h")).toEqual(["link:fresh"]);
  });

  it("pruneMessageLinks drops index keys whose link has already vanished", async () => {
    const { ctx, stateStore } = makeCtx();
    stateStore.set("link-index-i", ["link:gone"]);

    await pruneMessageLinks(ctx, "link-index-i", 30 * DAYS, Date.now());

    expect(stateStore.get("link-index-i")).toEqual([]);
  });

  it("pruneMessageLinks measures age against the injected now, not the wall clock", async () => {
    const { ctx, stateStore } = makeCtx();
    const createdAt = new Date().toISOString();
    stateStore.set("link:e-1", { channel: "C1", ts: "1.1", createdAt } satisfies MessageLink);
    stateStore.set("link-index-j", ["link:e-1"]);

    // A link created "now" is 31 days old when `now` is 31 days ahead.
    await pruneMessageLinks(ctx, "link-index-j", 30 * DAYS, Date.parse(createdAt) + 31 * DAYS);

    expect(stateStore.get("link:e-1")).toBeUndefined();
    expect(stateStore.get("link-index-j")).toEqual([]);
  });
});
