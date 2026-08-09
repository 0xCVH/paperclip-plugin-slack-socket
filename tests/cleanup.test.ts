import { describe, expect, it } from "vitest";
import { runCleanup } from "../src/cleanup.js";
import { STATE_KEYS } from "../src/constants.js";
import type { IssueThreadEntry, MessageLink, PendingQuestion, SessionEntry } from "../src/types.js";
import { FakeGateway, makeCtx, TEST_CONFIG } from "./helpers.js";

const HOURS = 3_600_000;

function session(threadTs: string, ageMs: number): SessionEntry {
  return {
    sessionId: `sess-${threadTs}`, channel: "C1", threadTs, scope: "thread",
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

  it("wakes the asking agent when a question expires", async () => {
    const { ctx, stateStore } = makeCtx();
    const key = STATE_KEYS.question("C1", "10.1");
    stateStore.set(key, {
      channel: "C1", ts: "10.1", issueId: "iss-1", companyId: "co-1", mode: "answer",
      question: "Ship it?", askedAt: new Date(Date.now() - 2 * HOURS).toISOString(), timeoutMinutes: 60,
    } satisfies PendingQuestion);
    stateStore.set(STATE_KEYS.questionIndex, [key]);

    await runCleanup(ctx, new FakeGateway(), TEST_CONFIG);

    expect(ctx.issues.requestWakeup).toHaveBeenCalledWith("iss-1", "co-1", {
      reason: "slack_ask_human_timeout",
      contextSource: "slack-socket.ask-human",
    });
  });

  it("still strikes the Slack message and deletes state when the wakeup fails", async () => {
    const { ctx, stateStore } = makeCtx();
    const gateway = new FakeGateway();
    (ctx.issues.requestWakeup as any).mockRejectedValueOnce(new Error("wakeup unavailable"));
    const key = STATE_KEYS.question("C1", "10.1");
    stateStore.set(key, {
      channel: "C1", ts: "10.1", issueId: "iss-1", companyId: "co-1", mode: "answer",
      question: "Ship it?", askedAt: new Date(Date.now() - 2 * HOURS).toISOString(), timeoutMinutes: 60,
    } satisfies PendingQuestion);
    stateStore.set(STATE_KEYS.questionIndex, [key]);

    await runCleanup(ctx, gateway, TEST_CONFIG);

    // Ordering is load-bearing: the wakeup sits in its own try/catch so a
    // wakeup failure can never leave a live-looking question in Slack.
    expect(gateway.updates).toHaveLength(1);
    expect(gateway.updates[0]!.ts).toBe("10.1");
    expect(stateStore.get(key)).toBeUndefined();
    expect(stateStore.get(STATE_KEYS.questionIndex)).toEqual([]);
    expect(ctx.logger.warn).toHaveBeenCalledWith(
      "Wakeup after Slack question expiry failed",
      expect.objectContaining({ issueId: "iss-1" }),
    );
  });

  it("does not wake anyone for a question still inside its timeout", async () => {
    const { ctx, stateStore } = makeCtx();
    const gateway = new FakeGateway();
    const key = STATE_KEYS.question("C1", "10.1");
    stateStore.set(key, {
      channel: "C1", ts: "10.1", issueId: "iss-1", companyId: "co-1", mode: "answer",
      question: "Q?", askedAt: new Date().toISOString(), timeoutMinutes: 60,
    } satisfies PendingQuestion);
    stateStore.set(STATE_KEYS.questionIndex, [key]);

    await runCleanup(ctx, gateway, TEST_CONFIG);

    expect(ctx.issues.requestWakeup).not.toHaveBeenCalled();
    expect(gateway.updates).toHaveLength(0);
    expect(stateStore.get(key)).toBeDefined();
    expect(stateStore.get(STATE_KEYS.questionIndex)).toEqual([key]);
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

  const DAYS = 24 * HOURS;

  it("prunes issue-thread entries older than 30 days and keeps fresh ones", async () => {
    const { ctx, stateStore } = makeCtx();
    const staleKey = STATE_KEYS.issueThread("iss-old");
    const freshKey = STATE_KEYS.issueThread("iss-new");
    const stale: IssueThreadEntry = {
      channel: "C1", ts: "1.1", createdAt: new Date(Date.now() - 31 * DAYS).toISOString(),
    };
    const fresh: IssueThreadEntry = {
      channel: "C1", ts: "2.1", createdAt: new Date(Date.now() - 1 * DAYS).toISOString(),
    };
    stateStore.set(staleKey, stale);
    stateStore.set(freshKey, fresh);
    stateStore.set(STATE_KEYS.issueThreadIndex, [staleKey, freshKey]);

    await runCleanup(ctx, new FakeGateway(), TEST_CONFIG);

    expect(stateStore.get(staleKey)).toBeUndefined();
    expect(stateStore.get(freshKey)).toEqual(fresh);
    expect(stateStore.get(STATE_KEYS.issueThreadIndex)).toEqual([freshKey]);
  });

  it("removes dead (missing) issue-thread index entries", async () => {
    const { ctx, stateStore } = makeCtx();
    const missingKey = STATE_KEYS.issueThread("iss-gone");
    stateStore.set(STATE_KEYS.issueThreadIndex, [missingKey]);

    await runCleanup(ctx, new FakeGateway(), TEST_CONFIG);

    expect(stateStore.get(STATE_KEYS.issueThreadIndex)).toEqual([]);
  });

  it("prunes approval-message links older than 30 days and keeps fresh ones", async () => {
    const { ctx, stateStore } = makeCtx();
    const staleKey = STATE_KEYS.approvalMessage("app-old");
    const freshKey = STATE_KEYS.approvalMessage("app-new");
    const stale: MessageLink = {
      channel: "C1", ts: "1.1", createdAt: new Date(Date.now() - 31 * DAYS).toISOString(),
    };
    const fresh: MessageLink = {
      channel: "C1", ts: "2.1", createdAt: new Date(Date.now() - 1 * DAYS).toISOString(),
    };
    stateStore.set(staleKey, stale);
    stateStore.set(freshKey, fresh);
    stateStore.set(STATE_KEYS.approvalMessageIndex, [staleKey, freshKey]);

    await runCleanup(ctx, new FakeGateway(), TEST_CONFIG);

    expect(stateStore.get(staleKey)).toBeUndefined();
    expect(stateStore.get(freshKey)).toEqual(fresh);
    expect(stateStore.get(STATE_KEYS.approvalMessageIndex)).toEqual([freshKey]);
  });
});
