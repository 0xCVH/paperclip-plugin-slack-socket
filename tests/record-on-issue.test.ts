import { describe, expect, it, vi } from "vitest";
import { CHAT_RUN_SETTLE_GRACE_MS, recordAgentPost } from "../src/chat-run-binding.js";
import { createChat } from "../src/chat.js";
import { STATE_KEYS, TOOL_NAMES } from "../src/constants.js";
import { createPostMessage } from "../src/post-message.js";
import {
  createRecordOnIssue,
  extractIssueLinkRefs,
  extractIssueRefs,
  RECORD_ON_ISSUE_RUN_CAP,
} from "../src/record-on-issue.js";
import type { ChatRunBinding, SlackSocketConfig, ThreadMessage } from "../src/types.js";
import { FakeGateway, makeCtx, TEST_CONFIG } from "./helpers.js";

// Slack ts are epoch seconds; the thread below is "now" so it is well
// inside the 30-day root age limit.
const NOW = Date.parse("2026-09-30T10:00:00.000Z");
const ROOT_TS = `${NOW / 1000 - 60}.000100`;
const RUN_CTX = { agentId: "agent-1", runId: "run-1", companyId: "co-1", projectId: "proj-1" };

const ISSUE = {
  id: "11111111-2222-3333-4444-555555555555",
  identifier: "POL-3267",
  companyId: "co-1",
  status: "in_progress",
  assigneeAgentId: "agent-owner",
  executionPolicy: null,
};
const OTHER = { ...ISSUE, id: "99999999-2222-3333-4444-555555555555", identifier: "POL-3179" };

type Result = { content?: string; error?: string; code?: string; data?: Record<string, unknown> };

function binding(overrides: Partial<ChatRunBinding> = {}): ChatRunBinding {
  const startedAt = new Date(NOW - 60_000).toISOString();
  return {
    runId: "run-1",
    agentId: "agent-1",
    sessionId: "sess-1",
    channel: "C-ESC",
    threadTs: ROOT_TS,
    triggerText: "please record this",
    triggerUser: "U-HUMAN",
    startedAt,
    createdAt: startedAt,
    ...overrides,
  };
}

const botRoot = (overrides: Partial<ThreadMessage> = {}): ThreadMessage => ({
  user: "UBOT",
  text: "CONFIRM · POL-3267 · Confirm the payout",
  ts: ROOT_TS,
  isBot: true,
  fromAnyBot: true,
  blockLinks: ["https://pc.example/POL/issues/POL-3267"],
  ...overrides,
});
const human = (text: string, ts = `${NOW / 1000 - 30}.000200`): ThreadMessage => ({
  user: "U-HUMAN", text, ts, isBot: false, fromAnyBot: false, blockLinks: [],
});

function setup(opts: { config?: Partial<SlackSocketConfig>; bind?: ChatRunBinding | null; now?: number } = {}) {
  const bundle = makeCtx();
  const gateway = new FakeGateway();
  const issues = new Map<string, typeof ISSUE>([
    [ISSUE.id, ISSUE], [ISSUE.identifier, ISSUE], [OTHER.id, OTHER], [OTHER.identifier, OTHER],
  ]);
  (bundle.ctx.issues.get as any).mockImplementation(async (ref: string) => issues.get(ref) ?? null);
  let commentSeq = 0;
  (bundle.ctx.issues.createComment as any).mockImplementation(async () => ({ id: `comment-${++commentSeq}` }));
  (bundle.ctx.issues.requestWakeup as any).mockResolvedValue({ queued: true, runId: "wake-run" });
  if (opts.bind !== null) bundle.stateStore.set(STATE_KEYS.chatRun("run-1"), opts.bind ?? binding());
  const tool = createRecordOnIssue({
    ctx: bundle.ctx,
    gateway,
    getConfig: async () => ({ ...TEST_CONFIG, ...opts.config }),
    now: () => opts.now ?? NOW,
  });
  tool.registerTool();
  const call = (bundle.ctx.tools.register as any).mock.calls[0];
  const handler = call[2] as (params: unknown, runCtx: typeof RUN_CTX) => Promise<Result>;
  return { ...bundle, gateway, issues, toolName: call[0] as string, handler };
}

describe("record_on_issue: scope parsing", () => {
  it("extracts identifiers case-insensitively and UUIDs", () => {
    expect([...extractIssueRefs(`see pol-3267 and ${ISSUE.id.toUpperCase()}`)]).toEqual(["POL-3267", ISSUE.id]);
  });

  it("reads only issue links on the configured base URL, from text and blocks", () => {
    const msg = botRoot({
      text: "<https://pc.example/issues/POL-1|x> <https://pc.example.evil/POL/issues/POL-2|y>",
      blockLinks: ["https://pc.example/POL/issues/POL-3?tab=chat", "https://pc.example/POL/projects/POL-4"],
    });
    expect([...extractIssueLinkRefs(msg, "https://pc.example/")].sort()).toEqual(["POL-1", "POL-3"]);
    expect(extractIssueLinkRefs(msg, "").size).toBe(0);
  });
});

describe("record_on_issue tool", () => {
  it("registers under record_on_issue", () => {
    expect(setup().toolName).toBe(TOOL_NAMES.recordOnIssue);
  });

  it("writes to the thread-linked issue found through the plugin's own thread link", async () => {
    const { ctx, handler, stateStore } = setup();
    stateStore.set(STATE_KEYS.threadIssue("C-ESC", ROOT_TS), {
      issueId: ISSUE.id, channel: "C-ESC", ts: ROOT_TS, createdAt: new Date(NOW).toISOString(),
    });
    const result = await handler({ issue: "POL-3267", body: "Ruling: authorised." }, RUN_CTX);
    expect(result.error).toBeUndefined();
    expect(result.data).toMatchObject({ ok: true, issueId: ISSUE.id, identifier: "POL-3267", woke: true });
    // Always the UUID: the host's createComment passes the raw id to addComment.
    expect(ctx.issues.createComment).toHaveBeenCalledWith(
      ISSUE.id, expect.stringContaining("Ruling: authorised."), "co-1", { authorAgentId: "agent-1" },
    );
    expect(ctx.activity.log).toHaveBeenCalledWith(expect.objectContaining({
      metadata: expect.objectContaining({ action: "slack.record_on_issue", scopeRule: "thread_linked", runId: "run-1" }),
    }));
  });

  it("writes to the issue linked from a bot-authored root (an escalation) via its block links", async () => {
    const { ctx, handler, gateway } = setup();
    gateway.threadReplies = [botRoot({ text: "" }), human("<@UBOT> check OCM #241")];
    const result = await handler({ issue: "POL-3267", body: "OCM #241 is a different Safe." }, RUN_CTX);
    expect(result.data).toMatchObject({ ok: true, issueId: ISSUE.id });
    expect(ctx.issues.createComment).toHaveBeenCalledTimes(1);
  });

  it("records a human's answer onto an escalation's issue (the POL-3099 thread, 2026-09-29)", async () => {
    // A resolved paperclip-escalate root (edited in place, same ts), then
    // Raúl's reply to the bot. The fix note belongs on POL-3099; that run
    // instead had to open a child issue because every write was refused.
    const pol3099 = { ...ISSUE, id: "33333333-2222-3333-4444-555555555555", identifier: "POL-3099", assigneeAgentId: "agent-meeseeks" };
    const { ctx, handler, gateway, issues } = setup({
      config: { paperclipBaseUrl: "https://scc.polygon.org" },
      bind: binding({ triggerText: "<@UBOT> the fix implemented was <https://github.com/0xPolygon/onchain-monitoring/pull/53|github.com/0xPolygon/onchain-monitoring/pull/53>" }),
    });
    issues.set("POL-3099", pol3099);
    gateway.threadReplies = [
      botRoot({
        text: ":white_check_mark: *RESOLVED* · ~CONFIRM~ · <https://scc.polygon.org/POL/issues/POL-3099|POL-3099>",
        blockLinks: [],
      }),
      human("<@U04T8P39TCM> <@U04UERHGKQT> we probably want to remove this alert, or keep it Informational"),
      human("I'll do a fix downgrading it from P1"),
      { user: "UBOT", text: "Resolved by Meeseeks …", ts: `${NOW / 1000 - 20}.000300`, isBot: true, fromAnyBot: true },
    ];
    const result = await handler({ issue: "POL-3099", body: "Severity downgrade shipped: onchain-monitoring PR #53." }, RUN_CTX);
    expect(result.data).toMatchObject({ ok: true, issueId: pol3099.id, woke: true });
    expect(ctx.issues.requestWakeup).toHaveBeenCalledWith(pol3099.id, "co-1", expect.anything());
  });

  it("refuses a root that carries a link but was posted by a human", async () => {
    const { ctx, handler, gateway } = setup();
    gateway.threadReplies = [{ ...human("<https://pc.example/POL/issues/POL-3179|POL-3179>"), ts: ROOT_TS }];
    // The human did name POL-3179, so it's in scope as human-named — but not
    // as the thread's own issue. POL-3267 is neither.
    const result = await handler({ issue: "POL-3267", body: "x" }, RUN_CTX);
    expect(result.code).toBe("issue_not_in_thread_scope");
    expect(ctx.issues.createComment).not.toHaveBeenCalled();
    const named = await handler({ issue: "POL-3179", body: "x" }, RUN_CTX);
    expect(ctx.activity.log).toHaveBeenLastCalledWith(expect.objectContaining({
      metadata: expect.objectContaining({ scopeRule: "human_named" }),
    }));
    expect(named.data).toMatchObject({ ok: true, issueId: OTHER.id });
  });

  it("refuses a bot-authored root whose words an agent chose (slack_post_message)", async () => {
    const { ctx, handler, gateway } = setup();
    await recordAgentPost(ctx, { channel: "C-ESC", ts: ROOT_TS });
    gateway.threadReplies = [botRoot()];
    const result = await handler({ issue: "POL-3267", body: "x" }, RUN_CTX);
    expect(result.code).toBe("issue_not_in_thread_scope");
    expect(ctx.issues.createComment).not.toHaveBeenCalled();
  });

  it("slack_post_message records its top-level posts as agent-worded, but not thread replies", async () => {
    const bundle = makeCtx();
    const gateway = new FakeGateway();
    createPostMessage({
      ctx: bundle.ctx,
      gateway,
      getConfig: async () => ({ ...TEST_CONFIG, agentPostMessageEnabled: true, agentPostToChannelsEnabled: true, agentPostChannelIds: ["C-ESC"] }),
    }).registerTool();
    const post = (bundle.ctx.tools.register as any).mock.calls[0][2];
    await post({ target: "C-ESC", text: "see https://pc.example/POL/issues/POL-9" }, RUN_CTX);
    await post({ target: "C-ESC", text: "reply", threadTs: "1.1" }, RUN_CTX);
    expect(bundle.stateStore.get(STATE_KEYS.agentPost("C-ESC", gateway.posts[0]!.ts))).toBeTruthy();
    expect(bundle.stateStore.get(STATE_KEYS.agentPost("C-ESC", gateway.posts[1]!.ts))).toBeUndefined();
  });

  it("refuses a bot root older than the agent-post retention window", async () => {
    const { handler, gateway } = setup({ now: NOW + 91 * 24 * 3_600_000, bind: binding({ startedAt: new Date(NOW + 91 * 24 * 3_600_000 - 1000).toISOString() }) });
    gateway.threadReplies = [botRoot()];
    expect((await handler({ issue: "POL-3267", body: "x" }, RUN_CTX)).code).toBe("issue_not_in_thread_scope");
  });

  it("allows an issue a human named in the thread", async () => {
    const { handler, gateway } = setup();
    gateway.threadReplies = [botRoot(), human("this is the same as pol-3179, add a recurrence note")];
    const result = await handler({ issue: "POL-3179", body: "Recurrence." }, RUN_CTX);
    expect(result.data).toMatchObject({ ok: true, issueId: OTHER.id });
  });

  it("allows an issue named in the turn's triggering message (a DM with no thread)", async () => {
    const { handler } = setup({ bind: binding({ threadTs: undefined, channel: "D1", triggerText: "note on POL-3179 please" }) });
    expect((await handler({ issue: "POL-3179", body: "Noted." }, RUN_CTX)).data).toMatchObject({ ok: true });
  });

  it("refuses an issue named only in bot or foreign-bot text", async () => {
    const { ctx, handler, gateway } = setup();
    gateway.threadReplies = [
      botRoot(),
      { user: "UBOT", text: "couldn't add this to POL-3179", ts: "2.1", isBot: true, fromAnyBot: true },
      { user: "UZAP", text: "POL-3179 mirrored", ts: "2.2", isBot: false, fromAnyBot: true },
    ];
    const result = await handler({ issue: "POL-3179", body: "x" }, RUN_CTX);
    expect(result.code).toBe("issue_not_in_thread_scope");
    expect(ctx.issues.createComment).not.toHaveBeenCalled();
  });

  it("fails closed to the stored link and trigger when the thread fetch fails", async () => {
    const { handler, gateway } = setup();
    gateway.fetchThreadReplies = vi.fn().mockRejectedValue(new Error("missing_scope"));
    expect((await handler({ issue: "POL-3267", body: "x" }, RUN_CTX)).code).toBe("issue_not_in_thread_scope");
  });

  it("refuses a run with no chat-run binding (a run the plugin did not start)", async () => {
    const { ctx, handler, gateway } = setup({ bind: null });
    gateway.threadReplies = [botRoot()];
    expect((await handler({ issue: "POL-3267", body: "x" }, RUN_CTX)).code).toBe("not_a_slack_chat_run");
    expect(ctx.issues.get).not.toHaveBeenCalled();
    expect(ctx.issues.createComment).not.toHaveBeenCalled();
  });

  it("refuses a binding past its settle grace period", async () => {
    const settledAt = new Date(NOW - CHAT_RUN_SETTLE_GRACE_MS - 1000).toISOString();
    const { handler, gateway } = setup({ bind: binding({ settledAt }) });
    gateway.threadReplies = [botRoot()];
    expect((await handler({ issue: "POL-3267", body: "x" }, RUN_CTX)).code).toBe("not_a_slack_chat_run");
  });

  it("refuses a binding made for a different agent", async () => {
    const { handler } = setup({ bind: binding({ agentId: "agent-other" }) });
    expect((await handler({ issue: "POL-3267", body: "x" }, RUN_CTX)).code).toBe("not_a_slack_chat_run");
  });

  it("refuses a company mismatch before reading any state", async () => {
    const { ctx, handler } = setup();
    const result = await handler({ issue: "POL-3267", body: "x" }, { ...RUN_CTX, companyId: "co-2" });
    expect(result.code).toBe("company_mismatch");
    expect(ctx.state.get).not.toHaveBeenCalled();
    expect(ctx.activity.log).not.toHaveBeenCalled();
    expect(ctx.issues.createComment).not.toHaveBeenCalled();
  });

  it("refuses an unknown issue and an issue under a trust policy", async () => {
    const { ctx, handler, gateway, issues } = setup();
    gateway.threadReplies = [botRoot()];
    expect((await handler({ issue: "POL-1", body: "x" }, RUN_CTX)).code).toBe("issue_not_found");
    issues.set("POL-3267", { ...ISSUE, executionPolicy: { trustPreset: "low_trust_review" } as any });
    expect((await handler({ issue: "POL-3267", body: "x" }, RUN_CTX)).code).toBe("low_trust_target");
    expect(ctx.issues.createComment).not.toHaveBeenCalled();
  });

  it("refuses empty and oversized bodies", async () => {
    const { handler } = setup();
    expect((await handler({ issue: "POL-3267", body: "   " }, RUN_CTX)).code).toBe("invalid_params");
    expect((await handler({ issue: "POL-3267", body: "a".repeat(8001) }, RUN_CTX)).code).toBe("invalid_params");
  });

  it("refuses the 21st write in a run, and the cap is per run", async () => {
    const { ctx, handler, gateway, stateStore } = setup();
    gateway.threadReplies = [botRoot()];
    for (let i = 0; i < RECORD_ON_ISSUE_RUN_CAP; i++) {
      expect((await handler({ issue: "POL-3267", body: `note ${i}` }, RUN_CTX)).data).toMatchObject({ ok: true });
    }
    expect((await handler({ issue: "POL-3267", body: "one more" }, RUN_CTX)).code).toBe("run_write_cap_exceeded");
    expect(ctx.issues.createComment).toHaveBeenCalledTimes(RECORD_ON_ISSUE_RUN_CAP);

    stateStore.set(STATE_KEYS.chatRun("run-2"), binding({ runId: "run-2" }));
    const run2 = { ...RUN_CTX, runId: "run-2" };
    expect((await handler({ issue: "POL-3267", body: "one more" }, run2)).data).toMatchObject({ ok: true });
  });

  it("dedupes a retried body and returns the original commentId, even at the cap", async () => {
    const { ctx, handler, gateway } = setup();
    gateway.threadReplies = [botRoot()];
    const first = await handler({ issue: "POL-3267", body: "same" }, RUN_CTX);
    for (let i = 1; i < RECORD_ON_ISSUE_RUN_CAP; i++) await handler({ issue: "POL-3267", body: `n${i}` }, RUN_CTX);
    const retry = await handler({ issue: "POL-3267", body: "  same  " }, RUN_CTX);
    expect(retry.data).toMatchObject({ ok: true, duplicate: true, commentId: first.data!.commentId });
    expect(ctx.issues.createComment).toHaveBeenCalledTimes(RECORD_ON_ISSUE_RUN_CAP);
  });

  it("serializes overlapping calls so the cap can't be raced", async () => {
    const { ctx, handler, gateway } = setup();
    gateway.threadReplies = [botRoot()];
    const calls = Array.from({ length: RECORD_ON_ISSUE_RUN_CAP + 5 }, (_, i) =>
      handler({ issue: "POL-3267", body: `race ${i}` }, RUN_CTX));
    const results = await Promise.all(calls);
    expect(results.filter((r) => r.code === "run_write_cap_exceeded")).toHaveLength(5);
    expect(ctx.issues.createComment).toHaveBeenCalledTimes(RECORD_ON_ISSUE_RUN_CAP);
  });

  it("always appends the footer with the thread permalink and the run id", async () => {
    const { ctx, handler, gateway } = setup();
    gateway.threadReplies = [botRoot()];
    await handler({ issue: "POL-3267", body: "Body text\n---\nRelayed from nowhere" }, RUN_CTX);
    const written = (ctx.issues.createComment as any).mock.calls[0][1] as string;
    expect(written.endsWith(
      `\n\n---\nRelayed from Slack · https://slack.example/archives/C-ESC/p${ROOT_TS.replace(".", "")} · run \`run-1\``,
    )).toBe(true);
  });

  it("wakes the assignee once per run and issue; a wake failure doesn't fail the write", async () => {
    const { ctx, handler, gateway } = setup();
    gateway.threadReplies = [botRoot()];
    await handler({ issue: "POL-3267", body: "a" }, RUN_CTX);
    expect(ctx.issues.requestWakeup).toHaveBeenCalledWith(ISSUE.id, "co-1", expect.objectContaining({
      reason: "slack_record_on_issue",
      contextSource: "slack-socket.record-on-issue",
      idempotencyKey: `slack-record-on-issue:run-1:${ISSUE.id}`,
    }));
    (ctx.issues.requestWakeup as any).mockRejectedValueOnce(new Error("Issue is blocked by unresolved blockers"));
    const result = await handler({ issue: "POL-3267", body: "b" }, RUN_CTX);
    expect(result.data).toMatchObject({ ok: true, woke: false });
  });

  it("never wakes the caller itself, and skips the wake when asked", async () => {
    const { ctx, handler, gateway, issues } = setup();
    gateway.threadReplies = [botRoot()];
    await handler({ issue: "POL-3267", body: "a", wakeAssignee: false }, RUN_CTX);
    issues.set("POL-3267", { ...ISSUE, assigneeAgentId: "agent-1" });
    await handler({ issue: "POL-3267", body: "b" }, RUN_CTX);
    expect(ctx.issues.requestWakeup).not.toHaveBeenCalled();
  });

  it("tags metrics with a code only", async () => {
    const { ctx, handler, gateway } = setup();
    gateway.threadReplies = [botRoot()];
    await handler({ issue: "POL-3267", body: "a" }, RUN_CTX);
    await handler({ issue: "POL-3179", body: "a" }, RUN_CTX);
    expect(ctx.metrics.write).toHaveBeenCalledWith("slack.record_on_issue.written", 1, { code: "thread_linked" });
    expect(ctx.metrics.write).toHaveBeenCalledWith("slack.record_on_issue.refused", 1, { code: "issue_not_in_thread_scope" });
  });
});

describe("cleanup of chat-run state", () => {
  it("drops expired bindings with their write logs and keeps live ones", async () => {
    const { pruneChatRunState } = await import("../src/chat-run-binding.js");
    const bundle = makeCtx();
    const live = binding({ runId: "run-live", startedAt: new Date(NOW - 60_000).toISOString() });
    const old = binding({ runId: "run-old", settledAt: new Date(NOW - CHAT_RUN_SETTLE_GRACE_MS - 1).toISOString() });
    for (const b of [live, old]) bundle.stateStore.set(STATE_KEYS.chatRun(b.runId), b);
    bundle.stateStore.set(STATE_KEYS.chatRunWrites("run-old"), [{ issueId: "i", bodyHash: "h", commentId: "c" }]);
    bundle.stateStore.set(STATE_KEYS.chatRunIndex, [STATE_KEYS.chatRun("run-live"), STATE_KEYS.chatRun("run-old")]);
    await pruneChatRunState(bundle.ctx, NOW);
    expect(bundle.stateStore.get(STATE_KEYS.chatRun("run-old"))).toBeUndefined();
    expect(bundle.stateStore.get(STATE_KEYS.chatRunWrites("run-old"))).toBeUndefined();
    expect(bundle.stateStore.get(STATE_KEYS.chatRunIndex)).toEqual([STATE_KEYS.chatRun("run-live")]);
  });
});

describe("chat turn -> run binding", () => {
  it("binds the host run to the Slack thread and marks it settled when the turn ends", async () => {
    const bundle = makeCtx();
    const gateway = new FakeGateway();
    const chat = createChat({
      ctx: bundle.ctx,
      gateway,
      getConfig: async () => ({ ...TEST_CONFIG, dmSessionMode: "thread" }),
      updateIntervalMs: 0,
    });
    await chat.handleMessage({ channel: "D1", channelType: "im", user: "U1", text: "record POL-3179", ts: "100.1" });
    const bound = bundle.stateStore.get(STATE_KEYS.chatRun("run-1")) as ChatRunBinding;
    expect(bound).toMatchObject({
      runId: "run-1", agentId: "agent-1", sessionId: "sess-1", channel: "D1", threadTs: "100.1",
      triggerText: "record POL-3179", triggerUser: "U1",
    });
    expect(bound.settledAt).toBeTruthy();
    expect(bundle.stateStore.get(STATE_KEYS.chatRunIndex)).toContain(STATE_KEYS.chatRun("run-1"));
  });
});
