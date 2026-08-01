import { describe, expect, it } from "vitest";
import { createEventDeduper } from "../src/event-dedup.js";

describe("createEventDeduper", () => {
  it("processes a new key and suppresses the same key seen again", () => {
    const now = 1_700_000_000_000;
    const deduper = createEventDeduper({ now: () => now });
    const key = `C1:${now / 1000}`;
    expect(deduper.shouldProcess(key)).toBe(true);
    expect(deduper.shouldProcess(key)).toBe(false);
  });

  it("suppresses an event older than maxAgeMs, judged from the injected now()", () => {
    const now = 1_700_000_000_000;
    const deduper = createEventDeduper({ now: () => now, maxAgeMs: 5 * 60_000 });
    const staleTs = (now - 10 * 60_000) / 1000; // 10 minutes before now
    expect(deduper.shouldProcess(`C1:${staleTs}`)).toBe(false);
  });

  it("does not suppress an event within maxAgeMs", () => {
    const now = 1_700_000_000_000;
    const deduper = createEventDeduper({ now: () => now, maxAgeMs: 5 * 60_000 });
    const freshTs = (now - 60_000) / 1000; // 1 minute before now
    expect(deduper.shouldProcess(`C1:${freshTs}`)).toBe(true);
  });

  it("does not record a stale event, so a later non-stale delivery of the same key still processes", () => {
    let now = 1_700_000_000_000;
    const deduper = createEventDeduper({ now: () => now, maxAgeMs: 5 * 60_000 });
    const ts = (now - 10 * 60_000) / 1000; // stale relative to `now`
    expect(deduper.shouldProcess(`C1:${ts}`)).toBe(false);
    now = ts * 1000 + 1000; // advance clock so the same ts is now fresh
    expect(deduper.shouldProcess(`C1:${ts}`)).toBe(true);
  });

  it("evicts the oldest entry once maxEntries is exceeded", () => {
    const now = 1_700_000_000_000;
    const deduper = createEventDeduper({ maxEntries: 2, now: () => now });
    const tsFor = (offsetSec: number) => (now / 1000 - offsetSec).toFixed(6);
    expect(deduper.shouldProcess(`C1:${tsFor(30)}`)).toBe(true);
    expect(deduper.shouldProcess(`C2:${tsFor(20)}`)).toBe(true);
    expect(deduper.shouldProcess(`C3:${tsFor(10)}`)).toBe(true); // evicts C1 entry
    // C1's key was evicted, so it is treated as new again — and re-adding it
    // now evicts C2 (the new oldest), keeping the set bounded at 2.
    expect(deduper.shouldProcess(`C1:${tsFor(30)}`)).toBe(true);
    // C3 is still tracked (was not evicted).
    expect(deduper.shouldProcess(`C3:${tsFor(10)}`)).toBe(false);
    // C2 was evicted in turn, so it is treated as new again.
    expect(deduper.shouldProcess(`C2:${tsFor(20)}`)).toBe(true);
  });
});
