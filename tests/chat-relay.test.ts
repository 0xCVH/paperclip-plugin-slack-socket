import { describe, expect, it } from "vitest";
import { buildChatPrompt, createChat } from "../src/chat.js";
import { STATE_KEYS } from "../src/constants.js";
import { createMentionRelay, type MentionRelay } from "../src/mention-relay.js";
import type { InboundMessage, SlackSocketConfig } from "../src/types.js";
import { FakeGateway, makeCtx, TEST_CONFIG } from "./helpers.js";

// How the mention relay and the conversation fit together: the person's
// message is on the issue before the agent is woken, and the agent's prompt
// says which issue the thread is about and that the message is already
// recorded — so it answers instead of trying to write.
const NOW = Date.parse("2026-09-30T12:17:00.000Z");
const ROOT_TS = `${NOW / 1000 - 3600}.000100`;
const MENTION_TS = `${NOW / 1000 - 5}.000200`;

const ISSUE = {
  id: "11111111-2222-3333-4444-555555555555",
  identifier: "POL-3099",
  companyId: "co-1",
  title: "CONFIRM · StakingNFT token 20\nmoved to a fresh EOA",
  status: "in_progress",
  assigneeAgentId: "agent-owner",
  executionPolicy: null,
};

const mention = (overrides: Partial<InboundMessage> = {}): InboundMessage => ({
  channel: "C-ESC",
  channelType: "channel",
  user: "U-HUMAN",
  text: "<@UBOT> what does the PR change?",
  ts: MENTION_TS,
  threadTs: ROOT_TS,
  ...overrides,
});

function setup(opts: { config?: Partial<SlackSocketConfig>; relay?: MentionRelay | "real"; pluginLink?: boolean } = {}) {
  const bundle = makeCtx();
  const gateway = new FakeGateway();
  const getConfig = async () => ({ ...TEST_CONFIG, seedThreadHistory: false, ...opts.config });
  (bundle.ctx.issues.get as any).mockImplementation(async (ref: string) =>
    ref === ISSUE.id || ref === ISSUE.identifier ? ISSUE : null,
  );
  (bundle.ctx.issues.createComment as any).mockResolvedValue({ id: "comment-7" });
  if (opts.pluginLink !== false) {
    bundle.stateStore.set(STATE_KEYS.threadIssue("C-ESC", ROOT_TS), {
      issueId: ISSUE.id, channel: "C-ESC", ts: ROOT_TS, createdAt: new Date(NOW).toISOString(),
    });
  }
  const relay =
    opts.relay === undefined || opts.relay === "real"
      ? createMentionRelay({ ctx: bundle.ctx, gateway, getConfig, now: () => NOW })
      : opts.relay;
  const chat = createChat({ ctx: bundle.ctx, gateway, getConfig, updateIntervalMs: 0, relay });
  const promptSent = (): string => (bundle.ctx.agents.sessions.sendMessage as any).mock.calls[0][2].prompt;
  return { ...bundle, gateway, chat, promptSent };
}

describe("buildChatPrompt with a linked-issue context block", () => {
  it("places the trusted context after the preamble and before the untrusted seed", () => {
    expect(buildChatPrompt("PRE", "hello", "<thread_context>seed</thread_context>", "CTX")).toBe(
      "PRE\n\nCTX\n\n<thread_context>seed</thread_context>\n\nSlack message:\nhello",
    );
    expect(buildChatPrompt("PRE", "hello", "", "CTX")).toBe("PRE\n\nCTX\n\nSlack message:\nhello");
    expect(buildChatPrompt("", "hello", "", "CTX")).toBe("CTX\n\nSlack message:\nhello");
  });

  it("is byte-identical to the old output when there is no context", () => {
    expect(buildChatPrompt("PRE", "hello", "SEED", "")).toBe(buildChatPrompt("PRE", "hello", "SEED"));
    expect(buildChatPrompt("", "hello", "", "")).toBe("hello");
  });
});

describe("chat turn with the mention relay", () => {
  it("records the mention on the thread's issue before the agent is woken", async () => {
    const { ctx, chat } = setup();
    await chat.handleMention(mention());
    expect(ctx.issues.createComment).toHaveBeenCalledTimes(1);
    expect(ctx.agents.sessions.sendMessage).toHaveBeenCalledTimes(1);
    const commentOrder = (ctx.issues.createComment as any).mock.invocationCallOrder[0];
    const sendOrder = (ctx.agents.sessions.sendMessage as any).mock.invocationCallOrder[0];
    expect(commentOrder).toBeLessThan(sendOrder);
  });

  it("tells the agent which issue the thread is about and that the message is already recorded", async () => {
    const { chat, promptSent } = setup();
    await chat.handleMention(mention());
    const prompt = promptSent();
    expect(prompt).toContain("Linked Paperclip issue: POL-3099");
    // The title is flattened to one line so it can't smuggle a fake prompt line.
    expect(prompt).toContain('"CONFIRM · StakingNFT token 20 moved to a fresh EOA"');
    expect(prompt).toContain("status: in_progress");
    expect(prompt).toContain("https://pc.example/POL/issues/POL-3099");
    expect(prompt).toContain("already been recorded on POL-3099 as comment comment-7");
    expect(prompt).toContain("Do not record it again");
    // The context sits before the person's message, which stays last.
    expect(prompt.indexOf("Linked Paperclip issue")).toBeLessThan(prompt.indexOf("Slack message:\nwhat does the PR change?"));
  });

  it("still names the issue when relaying is off, and says the message was not recorded", async () => {
    const { ctx, chat, promptSent } = setup({ config: { relayMentionsToIssue: false } });
    await chat.handleMention(mention());
    expect(ctx.issues.createComment).not.toHaveBeenCalled();
    const prompt = promptSent();
    expect(prompt).toContain("Linked Paperclip issue: POL-3099");
    expect(prompt).toContain("was not recorded on the issue");
    expect(prompt).not.toContain("already been recorded");
  });

  it("sends the plain prompt when the thread has no issue", async () => {
    const { ctx, chat, promptSent } = setup({ pluginLink: false });
    await chat.handleMention(mention());
    expect(ctx.issues.createComment).not.toHaveBeenCalled();
    expect(promptSent()).not.toContain("Linked Paperclip issue");
    expect(promptSent()).toContain("Slack message:\nwhat does the PR change?");
  });

  it("never lets a relay failure stop the conversation", async () => {
    const broken: MentionRelay = { relayMention: async () => { throw new Error("relay exploded"); } };
    const { ctx, gateway, chat, promptSent } = setup({ relay: broken });
    await chat.handleMention(mention());
    expect(ctx.agents.sessions.sendMessage).toHaveBeenCalledTimes(1);
    expect(promptSent()).not.toContain("Linked Paperclip issue");
    expect(gateway.updates.at(-1)!.text).toBe("Hello there!");
  });

  it("does not run the relay for a 1:1 DM turn", async () => {
    const { ctx, gateway, chat } = setup({ config: { dmSessionMode: "thread" } });
    await chat.handleMessage({ channel: "D1", channelType: "im", user: "U1", text: "hi", ts: "100.1" });
    expect(ctx.issues.createComment).not.toHaveBeenCalled();
    expect(gateway.threadFetches).toHaveLength(0);
  });

  it("works exactly as before when no relay is wired in", async () => {
    const bundle = makeCtx();
    const gateway = new FakeGateway();
    const chat = createChat({ ctx: bundle.ctx, gateway, getConfig: async () => TEST_CONFIG, updateIntervalMs: 0 });
    await chat.handleMention(mention());
    expect(bundle.ctx.issues.createComment).not.toHaveBeenCalled();
    expect(bundle.ctx.agents.sessions.sendMessage).toHaveBeenCalledTimes(1);
  });
});
