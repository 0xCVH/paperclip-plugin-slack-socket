import { describe, expect, it } from "vitest";
import { createCommands } from "../src/commands.js";
import { CHANNEL_SESSION_TS, STATE_KEYS } from "../src/constants.js";
import type { SessionEntry } from "../src/types.js";
import { FakeGateway, makeCtx, TEST_CONFIG } from "./helpers.js";

function setup() {
  const bundle = makeCtx();
  const gateway = new FakeGateway();
  const commands = createCommands({ ctx: bundle.ctx, gateway, getConfig: async () => TEST_CONFIG });
  return { ...bundle, gateway, commands };
}

const cmd = (text: string) => ({ command: "/paperclip", text, user: "U1", channel: "C1" });
// Slack gives a 1:1 IM a channel id starting with "D"; C…/G… are channels,
// private channels and group DMs.
const dmCmd = (text: string) => ({ command: "/paperclip", text, user: "U1", channel: "D1" });

const entry = (overrides: Partial<SessionEntry> = {}): SessionEntry => ({
  sessionId: "sess-dm", channel: "D1", threadTs: CHANNEL_SESSION_TS, scope: "channel",
  lastActivityAt: new Date().toISOString(), ...overrides,
});

describe("commands", () => {
  it("creates an issue and replies ephemerally with a link", async () => {
    const { ctx, gateway, commands } = setup();
    await commands.handleCommand(cmd("issue Fix the login flow"));
    expect(ctx.issues.create).toHaveBeenCalledWith({
      companyId: "co-1", title: "Fix the login flow", status: "todo",
    });
    expect(gateway.ephemerals[0]!.text).toContain("https://pc.example/issues/issue-1");
    expect(ctx.metrics.write).toHaveBeenCalledWith("slack.commands.invoked", 1, { subcommand: "issue" });
  });

  it("writes an invoked metric with subcommand 'help' for the help command", async () => {
    const { ctx, commands } = setup();
    await commands.handleCommand(cmd("help"));
    expect(ctx.metrics.write).toHaveBeenCalledWith("slack.commands.invoked", 1, { subcommand: "help" });
  });

  it("writes a failed metric when issue creation throws", async () => {
    const { ctx, commands } = setup();
    (ctx.issues.create as any).mockRejectedValueOnce(new Error("nope"));
    await commands.handleCommand(cmd("issue X"));
    expect(ctx.metrics.write).toHaveBeenCalledWith("slack.commands.failed", 1, { subcommand: "issue" });
  });

  it("shows usage when the title is missing", async () => {
    const { ctx, gateway, commands } = setup();
    await commands.handleCommand(cmd("issue"));
    expect(ctx.issues.create).not.toHaveBeenCalled();
    expect(gateway.ephemerals[0]!.text).toContain("Usage");
  });

  it("replies with help for anything else", async () => {
    const { gateway, commands } = setup();
    await commands.handleCommand(cmd("help"));
    expect(gateway.ephemerals[0]!.text).toContain("/paperclip issue");
  });

  it("reports failure ephemerally when issue creation throws", async () => {
    const { ctx, gateway, commands } = setup();
    (ctx.issues.create as any).mockRejectedValueOnce(new Error("nope"));
    await commands.handleCommand(cmd("issue X"));
    expect(gateway.ephemerals[0]!.text).toContain("Failed");
  });

  it("does not report a false failure when the issue was created but the success ephemeral fails (e.g. bot not in channel)", async () => {
    const { ctx, gateway, commands } = setup();
    gateway.postEphemeral = async () => {
      throw new Error("not_in_channel");
    };
    await commands.handleCommand(cmd("issue Fix the login flow"));
    expect(ctx.issues.create).toHaveBeenCalled();
    // No "Failed" ephemeral was posted for what was actually a successful creation.
    expect(gateway.ephemerals).toHaveLength(0);
    expect(ctx.logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("confirmation"),
      expect.objectContaining({ issueId: "issue-1" }),
    );
  });

  it("in a 1:1 DM, closes the channel-scoped session and clears its state and index membership", async () => {
    const { ctx, gateway, commands, stateStore } = setup();
    const key = STATE_KEYS.session("D1", CHANNEL_SESSION_TS);
    const other = STATE_KEYS.session("C9", "1.1");
    stateStore.set(key, entry());
    stateStore.set(STATE_KEYS.sessionIndex, [key, other]);

    await commands.handleCommand(dmCmd("reset"));

    expect(ctx.agents.sessions.close).toHaveBeenCalledWith("sess-dm", "co-1");
    expect(stateStore.get(key)).toBeUndefined();
    expect(stateStore.get(STATE_KEYS.sessionIndex)).toEqual([other]);
    expect(gateway.ephemerals[0]!.text).toContain("reset");
    expect(ctx.metrics.write).toHaveBeenCalledWith("slack.commands.invoked", 1, { subcommand: "reset" });
    expect(ctx.metrics.write).toHaveBeenCalledWith("slack.sessions.reset", 1, { surface: "command" });
  });

  it("in a channel, points at the in-thread keyword and closes nothing", async () => {
    const { ctx, gateway, commands, stateStore } = setup();
    const key = STATE_KEYS.session("C1", "50.1");
    stateStore.set(key, entry({ sessionId: "sess-thread", channel: "C1", threadTs: "50.1", scope: "thread" }));
    stateStore.set(STATE_KEYS.sessionIndex, [key]);

    await commands.handleCommand(cmd("reset"));

    expect(ctx.agents.sessions.close).not.toHaveBeenCalled();
    expect(stateStore.get(key)).toBeTruthy();
    expect(stateStore.get(STATE_KEYS.sessionIndex)).toEqual([key]);
    const text = gateway.ephemerals[0]!.text;
    expect(text).toContain("thread");
    expect(text).toContain("reset");
    // A thread-blind command must never claim there was nothing to reset.
    expect(text.toLowerCase()).not.toContain("nothing to reset");
  });

  it("is friendly, not an error, when a DM has no session to reset", async () => {
    const { ctx, gateway, commands } = setup();
    await commands.handleCommand(dmCmd("reset"));
    expect(ctx.agents.sessions.close).not.toHaveBeenCalled();
    expect(gateway.ephemerals[0]!.text).toContain("Nothing to reset");
    expect(gateway.ephemerals[0]!.text).not.toContain(":x:");
  });

  it("drops local state even when the host fails to close the session", async () => {
    const { ctx, gateway, commands, stateStore } = setup();
    const key = STATE_KEYS.session("D1", CHANNEL_SESSION_TS);
    stateStore.set(key, entry());
    stateStore.set(STATE_KEYS.sessionIndex, [key]);
    (ctx.agents.sessions.close as any).mockRejectedValueOnce(new Error("host down"));

    await commands.handleCommand(dmCmd("reset"));

    // A stale host-side session is strictly better than a DM wedged to a
    // session id the host has already forgotten.
    expect(stateStore.get(key)).toBeUndefined();
    expect(stateStore.get(STATE_KEYS.sessionIndex)).toEqual([]);
    expect(gateway.ephemerals[0]!.text).toContain("reset");
    expect(ctx.logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("reset"),
      expect.objectContaining({ sessionId: "sess-dm" }),
    );
  });

  it("documents reset in the help output", async () => {
    const { gateway, commands } = setup();
    await commands.handleCommand(cmd("help"));
    expect(gateway.ephemerals[0]!.text).toContain("/paperclip reset");
  });
});
