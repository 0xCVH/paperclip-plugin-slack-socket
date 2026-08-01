import { describe, expect, it } from "vitest";
import { createPostMessage } from "../src/post-message.js";
import { DEFAULT_CONFIG, TOOL_NAMES } from "../src/constants.js";
import type { SlackSocketConfig } from "../src/types.js";
import { FakeGateway, makeCtx } from "./helpers.js";

const RUN_CTX = { agentId: "agent-1", runId: "run-1", companyId: "co-1", projectId: "proj-1" };

type Handler = (params: unknown, runCtx: typeof RUN_CTX) => Promise<{
  content?: string; error?: string; data?: { channel: string; ts: string };
}>;

function setup(overrides: Partial<SlackSocketConfig> = {}) {
  const bundle = makeCtx();
  const gateway = new FakeGateway();
  const config: SlackSocketConfig = {
    ...DEFAULT_CONFIG,
    companyId: "co-1",
    agentPostMessageEnabled: true,
    agentPostToChannelsEnabled: true,
    agentPostChannelIds: ["C-OK"],
    agentDmEnabled: true,
    agentDmUserIds: ["U-OK"],
    ...overrides,
  };
  const postMessage = createPostMessage({ ctx: bundle.ctx, gateway, getConfig: async () => config });
  postMessage.registerTool();
  const call = (bundle.ctx.tools.register as any).mock.calls[0];
  return { ...bundle, gateway, toolName: call[0] as string, handler: call[2] as Handler };
}

describe("slack_post_message tool", () => {
  it("registers under the slack_post_message name and posts to an allowlisted channel", async () => {
    const { toolName, handler, gateway } = setup();
    expect(toolName).toBe(TOOL_NAMES.postMessage);
    const result = await handler({ target: "C-OK", text: "ship it" }, RUN_CTX);
    expect(result.error).toBeUndefined();
    expect(gateway.posts).toHaveLength(1);
    expect(gateway.posts[0]).toMatchObject({ channel: "C-OK", text: "ship it" });
    expect(result.data).toEqual({ channel: "C-OK", ts: gateway.posts[0]!.ts });
  });

  it("opens a DM and posts there when the target is an allowlisted user", async () => {
    const { handler, gateway } = setup();
    const result = await handler({ target: "U-OK", text: "hi" }, RUN_CTX);
    expect(gateway.dmOpens).toEqual(["U-OK"]);
    expect(gateway.posts[0]!.channel).toBe("D-U-OK");
    expect(result.data?.channel).toBe("D-U-OK");
  });

  it("refuses a target that is not allowlisted, without posting or opening a DM", async () => {
    const { handler, gateway } = setup();
    const result = await handler({ target: "C-SECRET", text: "leak" }, RUN_CTX);
    expect(result.error).toContain("agentPostChannelIds");
    expect(gateway.posts).toHaveLength(0);
    expect(gateway.dmOpens).toHaveLength(0);
  });

  it("refuses everything when the master switch is off", async () => {
    const { handler, gateway } = setup({ agentPostMessageEnabled: false });
    const result = await handler({ target: "C-OK", text: "hi" }, RUN_CTX);
    expect(result.error).toContain("agentPostMessageEnabled");
    expect(gateway.posts).toHaveLength(0);
  });

  it("rejects missing params without posting", async () => {
    const { handler, gateway } = setup();
    expect((await handler({ target: "C-OK" }, RUN_CTX)).error).toBeTruthy();
    expect((await handler({ text: "hi" }, RUN_CTX)).error).toBeTruthy();
    expect((await handler({ target: "C-OK", text: "   " }, RUN_CTX)).error).toBeTruthy();
    expect(gateway.posts).toHaveLength(0);
  });

  it("escapes Slack control sequences so an agent cannot ping the channel", async () => {
    const { handler, gateway } = setup();
    await handler({ target: "C-OK", text: "hey <!channel> look" }, RUN_CTX);
    expect(gateway.posts[0]!.text).toBe("hey &lt;!channel&gt; look");
  });

  it("escapes a hand-authored link so its destination cannot be disguised", async () => {
    const { handler, gateway } = setup();
    await handler({ target: "C-OK", text: "<https://evil.example|Payroll>" }, RUN_CTX);
    expect(gateway.posts[0]!.text).not.toContain("<https://evil.example|");
  });

  it("still converts the agent's own Markdown link into Slack link syntax", async () => {
    const { handler, gateway } = setup();
    await handler({ target: "C-OK", text: "see [the docs](https://ok.example)" }, RUN_CTX);
    expect(gateway.posts[0]!.text).toBe("see <https://ok.example|the docs>");
  });

  it("converts Markdown bold to mrkdwn", async () => {
    const { handler, gateway } = setup();
    await handler({ target: "C-OK", text: "**done**" }, RUN_CTX);
    expect(gateway.posts[0]!.text).toBe("*done*");
  });

  it("passes threadTs through", async () => {
    const { handler, gateway } = setup();
    await handler({ target: "C-OK", text: "hi", threadTs: "1700.5" }, RUN_CTX);
    expect(gateway.posts[0]!.threadTs).toBe("1700.5");
  });

  it("splits an overlong message and threads the remainder under the first post", async () => {
    const { handler, gateway } = setup();
    await handler({ target: "C-OK", text: "a".repeat(4200) }, RUN_CTX);
    expect(gateway.posts).toHaveLength(2);
    expect(gateway.posts[0]!.text).toHaveLength(3900);
    expect(gateway.posts[1]!.text).toHaveLength(300);
    expect(gateway.posts[1]!.threadTs).toBe(gateway.posts[0]!.ts);
  });

  it("returns an error instead of throwing when Slack fails", async () => {
    const { handler, gateway } = setup();
    gateway.postMessage = async () => { throw new Error("channel_not_found"); };
    const result = await handler({ target: "C-OK", text: "hi" }, RUN_CTX);
    expect(result.error).toContain("channel_not_found");
  });

  it("writes a metric on both the posted and refused paths", async () => {
    const { handler, ctx } = setup();
    await handler({ target: "C-OK", text: "hi" }, RUN_CTX);
    await handler({ target: "C-NOPE", text: "hi" }, RUN_CTX);
    const names = (ctx.metrics.write as any).mock.calls.map((c: unknown[]) => c[0]);
    expect(names).toContain("slack.messages.posted");
    expect(names).toContain("slack.messages.refused");
  });
});
