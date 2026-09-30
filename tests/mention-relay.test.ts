import { describe, expect, it, vi } from "vitest";
import { recordAgentPost } from "../src/chat-run-binding.js";
import { STATE_KEYS } from "../src/constants.js";
import { createMentionRelay, MENTION_RELAY_MAX_BODY } from "../src/mention-relay.js";
import type { InboundMessage, SlackSocketConfig, ThreadMessage } from "../src/types.js";
import { FakeGateway, makeCtx, TEST_CONFIG } from "./helpers.js";

// Slack ts are epoch seconds; the thread below is "now" so the root is well
// inside the link age limit.
const NOW = Date.parse("2026-09-30T12:17:00.000Z");
const ROOT_TS = `${NOW / 1000 - 3600}.000100`;
const MENTION_TS = `${NOW / 1000 - 5}.000200`;

const ISSUE = {
  id: "11111111-2222-3333-4444-555555555555",
  identifier: "POL-3099",
  companyId: "co-1",
  title: "CONFIRM · StakingNFT token 20 moved to a fresh EOA",
  status: "in_progress",
  assigneeAgentId: "agent-owner",
  executionPolicy: null,
};
const OTHER = { ...ISSUE, id: "99999999-2222-3333-4444-555555555555", identifier: "POL-3179", title: "Relay bug" };

const botRoot = (overrides: Partial<ThreadMessage> = {}): ThreadMessage => ({
  user: "UBOT",
  text: ":white_check_mark: RESOLVED · POL-3099",
  ts: ROOT_TS,
  isBot: true,
  fromAnyBot: true,
  blockLinks: ["https://pc.example/POL/issues/POL-3099"],
  ...overrides,
});
const human = (text: string, ts: string): ThreadMessage => ({
  user: "U-HUMAN", text, ts, isBot: false, fromAnyBot: false, blockLinks: [],
});

const mention = (overrides: Partial<InboundMessage> = {}): InboundMessage => ({
  channel: "C-ESC",
  channelType: "channel",
  user: "U-HUMAN",
  text: "<@UBOT> the fix implemented was <https://github.com/0xPolygon/onchain-monitoring/pull/53|PR #53>",
  ts: MENTION_TS,
  threadTs: ROOT_TS,
  ...overrides,
});

function setup(opts: { config?: Partial<SlackSocketConfig>; replies?: ThreadMessage[]; pluginLink?: boolean } = {}) {
  const bundle = makeCtx();
  const gateway = new FakeGateway();
  gateway.threadReplies = opts.replies ?? [botRoot(), human("thanks", `${NOW / 1000 - 1800}.000150`)];
  const issues = new Map<string, typeof ISSUE>([
    [ISSUE.id, ISSUE], [ISSUE.identifier, ISSUE], [OTHER.id, OTHER], [OTHER.identifier, OTHER],
  ]);
  (bundle.ctx.issues.get as any).mockImplementation(async (ref: string) => issues.get(ref) ?? null);
  let commentSeq = 0;
  (bundle.ctx.issues.createComment as any).mockImplementation(async () => ({ id: `comment-${++commentSeq}` }));
  (bundle.ctx.issues.requestWakeup as any).mockResolvedValue({ queued: true, runId: "wake-run" });
  if (opts.pluginLink) {
    bundle.stateStore.set(STATE_KEYS.threadIssue("C-ESC", ROOT_TS), {
      issueId: ISSUE.id, channel: "C-ESC", ts: ROOT_TS, createdAt: new Date(NOW).toISOString(),
    });
  }
  const relay = createMentionRelay({
    ctx: bundle.ctx,
    gateway,
    getConfig: async () => ({ ...TEST_CONFIG, ...opts.config }),
    now: () => NOW,
  });
  return { ...bundle, gateway, issues, relay };
}

describe("mention relay: which mentions are recorded", () => {
  it("records a mention in a thread the plugin linked to an issue, as a quoted human comment", async () => {
    const { ctx, relay } = setup({ pluginLink: true, replies: [] });
    const outcome = await relay.relayMention(mention());

    expect(outcome.skipped).toBeNull();
    expect(outcome.issue).toMatchObject({ id: ISSUE.id, identifier: "POL-3099", rule: "plugin_link" });
    expect(outcome.recorded).toMatchObject({ commentId: "comment-1", duplicate: false, woke: true });

    expect(ctx.issues.createComment).toHaveBeenCalledTimes(1);
    const [issueId, body, companyId, options] = (ctx.issues.createComment as any).mock.calls[0];
    expect(issueId).toBe(ISSUE.id);
    expect(companyId).toBe("co-1");
    // Attributed to the Slack agent: the plugin has no human attribution capability.
    expect(options).toEqual({ authorAgentId: "agent-1" });
    // Header names the person, carries their unforgeable Slack id and the permalink.
    expect(body).toContain("**Human input from Slack** — name-U-HUMAN (U-HUMAN)");
    expect(body).toContain(`https://slack.example/archives/C-ESC/p${MENTION_TS.replace(".", "")}`);
    expect(body).toContain(new Date(Number(MENTION_TS) * 1000).toISOString());
    // The person's words are quoted verbatim, with Slack's link entity rendered as Markdown.
    expect(body).toContain("> the fix implemented was [PR #53](https://github.com/0xPolygon/onchain-monitoring/pull/53)");
    // The bot mention itself never lands on the issue.
    expect(body).not.toContain("<@UBOT>");
    expect(body).toContain("Relayed automatically");

    expect(ctx.activity.log).toHaveBeenCalledWith(expect.objectContaining({
      entityId: ISSUE.id,
      metadata: expect.objectContaining({
        action: "slack.mention_relay", identifier: "POL-3099", commentId: "comment-1", rule: "plugin_link",
      }),
    }));
    expect(ctx.metrics.write).toHaveBeenCalledWith("slack.mention_relay.written", 1, { rule: "plugin_link" });
  });

  it("finds the issue from a thread root this bot posted with an issue link, when there is no plugin link", async () => {
    const { ctx, relay } = setup();
    const outcome = await relay.relayMention(mention());
    expect(outcome.issue).toMatchObject({ id: ISSUE.id, identifier: "POL-3099", rule: "bot_root_link" });
    expect(outcome.recorded).toMatchObject({ commentId: "comment-1" });
    expect(ctx.issues.createComment).toHaveBeenCalledTimes(1);
  });

  it("does not let a human-posted root with an issue link make that issue the thread's issue", async () => {
    const { ctx, relay } = setup({ replies: [botRoot({ user: "U-HUMAN", isBot: false, fromAnyBot: false })] });
    const outcome = await relay.relayMention(mention());
    expect(outcome).toMatchObject({ issue: null, recorded: null, skipped: "no_linked_issue" });
    expect(ctx.issues.createComment).not.toHaveBeenCalled();
  });

  it("does not read an agent-worded bot root (slack_post_message, ask_human) as linking an issue", async () => {
    const { ctx, relay } = setup();
    await recordAgentPost(ctx, { channel: "C-ESC", ts: ROOT_TS });
    const outcome = await relay.relayMention(mention());
    expect(outcome.skipped).toBe("no_linked_issue");
    expect(ctx.issues.createComment).not.toHaveBeenCalled();
  });

  it("skips a 1:1 DM without touching Slack or the issue API", async () => {
    const { ctx, gateway, relay } = setup();
    const outcome = await relay.relayMention(mention({ channel: "D1", channelType: "im" }));
    expect(outcome).toMatchObject({ issue: null, recorded: null, skipped: "dm" });
    expect(gateway.threadFetches).toHaveLength(0);
    expect(ctx.issues.get).not.toHaveBeenCalled();
  });

  it("skips a top-level channel mention — no thread, no issue", async () => {
    const { ctx, relay } = setup();
    const outcome = await relay.relayMention(mention({ threadTs: undefined }));
    expect(outcome.skipped).toBe("not_a_thread");
    expect(ctx.issues.createComment).not.toHaveBeenCalled();
  });

  it("skips the reset keyword and an empty mention", async () => {
    const { ctx, relay } = setup({ pluginLink: true });
    expect((await relay.relayMention(mention({ text: "<@UBOT> Reset" }))).skipped).toBe("control_keyword");
    expect((await relay.relayMention(mention({ text: "<@UBOT>  " }))).skipped).toBe("empty");
    expect(ctx.issues.createComment).not.toHaveBeenCalled();
  });

  it("still resolves the issue for context when relaying is switched off, but writes nothing", async () => {
    const { ctx, relay } = setup({ pluginLink: true, config: { relayMentionsToIssue: false } });
    const outcome = await relay.relayMention(mention());
    expect(outcome.issue).toMatchObject({ identifier: "POL-3099", title: ISSUE.title, status: "in_progress" });
    expect(outcome.recorded).toBeNull();
    expect(outcome.skipped).toBe("disabled");
    expect(ctx.issues.createComment).not.toHaveBeenCalled();
  });

  it("refuses to write to an issue under a trust policy, whose comments the host would quarantine", async () => {
    const { ctx, issues, relay } = setup({ pluginLink: true });
    issues.set(ISSUE.id, { ...ISSUE, executionPolicy: { trustPreset: "untrusted_inbound" } as unknown as null });
    const outcome = await relay.relayMention(mention());
    expect(outcome.skipped).toBe("low_trust_target");
    expect(outcome.issue).toMatchObject({ id: ISSUE.id });
    expect(ctx.issues.createComment).not.toHaveBeenCalled();
  });

  it("writes nothing when the plugin link and the root link disagree about the issue", async () => {
    const { ctx, relay } = setup({
      pluginLink: true,
      replies: [botRoot({ blockLinks: ["https://pc.example/POL/issues/POL-3179"] })],
    });
    const outcome = await relay.relayMention(mention());
    expect(outcome.skipped).toBe("ambiguous_linked_issue");
    expect(outcome.issue).toBeNull();
    expect(ctx.issues.createComment).not.toHaveBeenCalled();
  });

  it("reports issue_not_found when the linked issue no longer resolves", async () => {
    const { ctx, issues, relay } = setup({ pluginLink: true });
    issues.clear();
    const outcome = await relay.relayMention(mention());
    expect(outcome.skipped).toBe("issue_not_found");
    expect(ctx.issues.createComment).not.toHaveBeenCalled();
  });
});

describe("mention relay: idempotency and wakes", () => {
  it("records a redelivered mention only once and returns the original comment", async () => {
    const { ctx, relay } = setup({ pluginLink: true });
    const first = await relay.relayMention(mention());
    const second = await relay.relayMention(mention());
    expect(ctx.issues.createComment).toHaveBeenCalledTimes(1);
    expect(second.recorded).toMatchObject({ commentId: first.recorded!.commentId, duplicate: true, woke: false });
    expect(second.issue).toMatchObject({ id: ISSUE.id });
  });

  it("wakes the assignee of an open issue with an idempotency key tied to the mention", async () => {
    const { ctx, relay } = setup({ pluginLink: true });
    await relay.relayMention(mention());
    expect(ctx.issues.requestWakeup).toHaveBeenCalledWith(ISSUE.id, "co-1", {
      reason: "slack_mention_relayed",
      contextSource: "slack-socket.mention-relay",
      idempotencyKey: `slack-mention-relay:C-ESC:${MENTION_TS}`,
    });
  });

  it("does not wake a closed issue's assignee, nor the Slack agent itself", async () => {
    const { ctx, issues, relay } = setup({ pluginLink: true });
    issues.set(ISSUE.id, { ...ISSUE, status: "done" });
    expect((await relay.relayMention(mention())).recorded).toMatchObject({ woke: false });
    issues.set(ISSUE.id, { ...ISSUE, assigneeAgentId: "agent-1" });
    expect((await relay.relayMention(mention({ ts: `${NOW / 1000 - 4}.000300` }))).recorded).toMatchObject({ woke: false });
    expect(ctx.issues.requestWakeup).not.toHaveBeenCalled();
  });

  it("treats a failed wake as a logged warning, not a failed relay", async () => {
    const { ctx, relay } = setup({ pluginLink: true });
    (ctx.issues.requestWakeup as any).mockRejectedValue(new Error("wake exploded"));
    const outcome = await relay.relayMention(mention());
    expect(outcome.recorded).toMatchObject({ commentId: "comment-1", woke: false });
    expect(outcome.skipped).toBeNull();
  });

  it("reports write_failed and keeps the issue context when createComment rejects", async () => {
    const { ctx, relay } = setup({ pluginLink: true });
    (ctx.issues.createComment as any).mockRejectedValue(new Error("boom"));
    const outcome = await relay.relayMention(mention());
    expect(outcome).toMatchObject({ recorded: null, skipped: "write_failed" });
    expect(outcome.issue).toMatchObject({ id: ISSUE.id });
    expect(ctx.metrics.write).toHaveBeenCalledWith("slack.mention_relay.skipped", 1, { code: "write_failed" });
  });

  it("truncates an over-long message instead of refusing it", async () => {
    const { ctx, relay } = setup({ pluginLink: true });
    const outcome = await relay.relayMention(mention({ text: `<@UBOT> ${"x".repeat(MENTION_RELAY_MAX_BODY + 500)}` }));
    expect(outcome.recorded).toMatchObject({ commentId: "comment-1" });
    const body = (ctx.issues.createComment as any).mock.calls[0][1] as string;
    expect(body).toContain("[truncated]");
    expect(body.length).toBeLessThan(MENTION_RELAY_MAX_BODY + 1000);
  });
});

// Review findings, 2026-09-30: bot authorship, overlapping deliveries,
// restart survival, quoting and header hardening, lookup errors, fallbacks.
class DegradedGateway extends FakeGateway {
  override async getPermalink(): Promise<string | null> { return null; }
  override async getUserDisplayName(): Promise<string> { throw new Error("users.info failed"); }
}

describe("mention relay: authorship and delivery hardening", () => {
  it("never relays a mention authored by a bot, nor one with no author", async () => {
    const { ctx, relay } = setup({ pluginLink: true });
    expect((await relay.relayMention(mention({ fromBot: true, user: "UOTHERBOT" }))).skipped).toBe("bot_author");
    expect((await relay.relayMention(mention({ user: "", ts: `${NOW / 1000 - 4}.000300` }))).skipped).toBe("bot_author");
    expect(ctx.issues.createComment).not.toHaveBeenCalled();
    expect(ctx.issues.requestWakeup).not.toHaveBeenCalled();
  });

  it("shares one write between overlapping deliveries of the same mention", async () => {
    const { ctx, relay } = setup({ pluginLink: true });
    let release!: (value: { id: string }) => void;
    (ctx.issues.createComment as any).mockImplementation(() => new Promise((r) => { release = r; }));
    const first = relay.relayMention(mention());
    const second = relay.relayMention(mention());
    await vi.waitFor(() => expect(ctx.issues.createComment).toHaveBeenCalledTimes(1));
    release({ id: "comment-1" });
    const [a, b] = await Promise.all([first, second]);
    expect(ctx.issues.createComment).toHaveBeenCalledTimes(1);
    expect(a.recorded).toMatchObject({ commentId: "comment-1", duplicate: false });
    expect(b).toEqual(a);
  });

  it("recognises an already-relayed mention after a restart, from state alone", async () => {
    const { ctx, gateway, relay, stateStore } = setup({ pluginLink: true });
    await relay.relayMention(mention());
    const restarted = createMentionRelay({ ctx, gateway, getConfig: async () => TEST_CONFIG, now: () => NOW + 60_000 });
    const again = await restarted.relayMention(mention());
    expect(ctx.issues.createComment).toHaveBeenCalledTimes(1);
    expect(again.recorded).toMatchObject({ commentId: "comment-1", duplicate: true });
    expect(stateStore.get(STATE_KEYS.relayedMentionIndex)).toEqual([STATE_KEYS.relayedMention("C-ESC", MENTION_TS)]);
  });

  it("quotes every line, whichever line ending the client sent", async () => {
    const { ctx, relay } = setup({ pluginLink: true });
    await relay.relayMention(mention({ text: "<@UBOT> a\rb\r\nc\nd" }));
    const body = (ctx.issues.createComment as any).mock.calls[0][1] as string;
    expect(body).toContain("> a\n> b\n> c\n> d");
    expect(body).not.toMatch(/\r/);
  });

  it("flattens and caps the display name so it cannot forge the header's other fields", async () => {
    const { ctx, gateway, relay } = setup({ pluginLink: true });
    gateway.getUserDisplayName = async () => `Alice (U-ADMIN) —\n2026-01-01T00:00:00.000Z — ${"x".repeat(200)}`;
    await relay.relayMention(mention());
    const header = ((ctx.issues.createComment as any).mock.calls[0][1] as string).split("\n")[0]!;
    expect(header).not.toMatch(/\n/);
    expect(header).toContain("(U-HUMAN),");
    // The name is one line and at most 80 characters, then the real id follows.
    const name = header.slice("**Human input from Slack** — ".length, header.indexOf(" (U-HUMAN),"));
    expect(name.length).toBeLessThanOrEqual(80);
    expect(name).toBe(name.replace(/\s+/g, " "));
  });

  it("writes nothing when a linked-issue lookup throws, rather than trusting the refs it could resolve", async () => {
    const { ctx, relay } = setup({ pluginLink: true });
    (ctx.issues.get as any).mockImplementation(async (ref: string) => {
      if (ref === ISSUE.id) throw new Error("host unavailable");
      return ref === "POL-3099" ? ISSUE : null;
    });
    const outcome = await relay.relayMention(mention());
    expect(outcome.skipped).toBe("lookup_failed");
    expect(ctx.issues.createComment).not.toHaveBeenCalled();
  });

  it("falls back to the Slack user id and the channel when the display name and permalink are unavailable", async () => {
    const bundle = makeCtx();
    const gateway = new DegradedGateway();
    (bundle.ctx.issues.get as any).mockImplementation(async (ref: string) => (ref === ISSUE.id ? ISSUE : null));
    (bundle.ctx.issues.createComment as any).mockResolvedValue({ id: "comment-1" });
    bundle.stateStore.set(STATE_KEYS.threadIssue("C-ESC", ROOT_TS), {
      issueId: ISSUE.id, channel: "C-ESC", ts: ROOT_TS, createdAt: new Date(NOW).toISOString(),
    });
    const relay = createMentionRelay({ ctx: bundle.ctx, gateway, getConfig: async () => TEST_CONFIG, now: () => NOW });
    const outcome = await relay.relayMention(mention());
    expect(outcome.recorded).toMatchObject({ commentId: "comment-1" });
    const header = ((bundle.ctx.issues.createComment as any).mock.calls[0][1] as string).split("\n")[0]!;
    expect(header).toContain("— U-HUMAN (U-HUMAN),");
    expect(header).toContain("— Slack channel C-ESC");
  });

  it("credits the plugin link when it and the bot root agree on the issue", async () => {
    const { relay } = setup({ pluginLink: true });
    const outcome = await relay.relayMention(mention());
    expect(outcome.issue).toMatchObject({ id: ISSUE.id, rule: "plugin_link" });
  });
});
