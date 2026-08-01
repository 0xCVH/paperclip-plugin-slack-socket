import { describe, expect, it } from "vitest";
import { runCleanup } from "../src/cleanup.js";
import { STATE_KEYS } from "../src/constants.js";
import type { PendingQuestion, SessionEntry } from "../src/types.js";
import { FakeGateway, makeCtx, TEST_CONFIG } from "./helpers.js";

const HOURS = 3_600_000;

function session(threadTs: string, ageMs: number): SessionEntry {
  return {
    sessionId: `sess-${threadTs}`, channel: "C1", threadTs,
    lastActivityAt: new Date(Date.now() - ageMs).toISOString(),
  };
}

describe("runCleanup", () => {
  it("closes idle sessions and keeps fresh ones", async () => {
    const { ctx, stateStore } = makeCtx();
    const staleKey = STATE_KEYS.session("C1", "1.1");
    const freshKey = STATE_KEYS.session("C1", "2.1");
    stateStore.set(staleKey, session("1.1", 25 * HOURS));
    stateStore.set(freshKey, session("2.1", 1 * HOURS));
    stateStore.set(STATE_KEYS.sessionIndex, [staleKey, freshKey]);

    await runCleanup(ctx, new FakeGateway(), TEST_CONFIG);

    expect(ctx.agents.sessions.close).toHaveBeenCalledWith("sess-1.1", "co-1");
    expect(ctx.agents.sessions.close).toHaveBeenCalledTimes(1);
    expect(stateStore.get(staleKey)).toBeUndefined();
    expect(stateStore.get(STATE_KEYS.sessionIndex)).toEqual([freshKey]);
  });

  it("expires timed-out questions: comment, Slack update, state removal", async () => {
    const { ctx, stateStore } = makeCtx();
    const gateway = new FakeGateway();
    const key = STATE_KEYS.question("C1", "10.1");
    const expired: PendingQuestion = {
      channel: "C1", ts: "10.1", issueId: "iss-1", companyId: "co-1", mode: "answer",
      question: "Ship it?", askedAt: new Date(Date.now() - 2 * HOURS).toISOString(), timeoutMinutes: 60,
    };
    stateStore.set(key, expired);
    stateStore.set(STATE_KEYS.questionIndex, [key]);

    await runCleanup(ctx, gateway, TEST_CONFIG);

    expect(ctx.issues.createComment).toHaveBeenCalledWith(
      "iss-1", expect.stringContaining("No Slack response"), "co-1",
    );
    expect(gateway.updates[0]!.ts).toBe("10.1");
    expect(stateStore.get(key)).toBeUndefined();
    expect(stateStore.get(STATE_KEYS.questionIndex)).toEqual([]);
  });

  it("keeps questions still inside their timeout", async () => {
    const { ctx, stateStore } = makeCtx();
    const key = STATE_KEYS.question("C1", "10.1");
    stateStore.set(key, {
      channel: "C1", ts: "10.1", issueId: "iss-1", companyId: "co-1", mode: "answer",
      question: "Q?", askedAt: new Date().toISOString(), timeoutMinutes: 60,
    } satisfies PendingQuestion);
    stateStore.set(STATE_KEYS.questionIndex, [key]);

    await runCleanup(ctx, new FakeGateway(), TEST_CONFIG);

    expect(ctx.issues.createComment).not.toHaveBeenCalled();
    expect(stateStore.get(STATE_KEYS.questionIndex)).toEqual([key]);
  });
});
