import type { PluginContext } from "@paperclipai/plugin-sdk";
import { resetSession } from "./chat.js";
import { CHANNEL_SESSION_TS, RESET_KEYWORD, STATE_KEYS } from "./constants.js";
import { errString } from "./redact.js";
import { isDmChannelId } from "./slack-ids.js";
import type { InboundCommand, SlackGateway, SlackSocketConfig } from "./types.js";

export interface CommandDeps {
  ctx: PluginContext;
  gateway: SlackGateway;
  getConfig: () => Promise<SlackSocketConfig>;
}

export interface Commands {
  handleCommand(cmd: InboundCommand): Promise<void>;
}

const HELP = [
  "*Paperclip commands*",
  "• `/paperclip issue <title>` — create a Paperclip issue",
  "• `/paperclip reset` — start a fresh conversation in this DM",
  "• `/paperclip help` — show this help",
].join("\n");

// Shown whenever `/paperclip reset` has no thread_ts to work with and the
// conversation it would need to target is thread-scoped: any non-DM channel
// (always thread-scoped by design), and a 1:1 DM under dmSessionMode
// "thread" (see resolveSessionScope in chat.ts — under that mode a DM is
// thread-scoped exactly like a channel, so nothing is ever stored under the
// CHANNEL_SESSION_TS sentinel this command would otherwise look up). Both
// cases share the same underlying reason, so they share the same pointer
// rather than two near-duplicate strings.
const THREAD_SCOPED_RESET_POINTER =
  "Each conversation here lives in its own thread, and a slash command can't tell which thread you're in. " +
  "Mention me with `reset` in the thread you want to clear instead: `@Paperclip reset`.";

export function createCommands({ ctx, gateway, getConfig }: CommandDeps): Commands {
  return {
    async handleCommand(cmd) {
      const cfg = await getConfig();
      const [sub, ...rest] = cmd.text.trim().split(/\s+/);
      const subcommand = sub === "issue" || sub === RESET_KEYWORD ? sub : "help";
      await ctx.metrics.write("slack.commands.invoked", 1, { subcommand }).catch(() => {});

      if (sub === RESET_KEYWORD) {
        // A slash-command payload carries channel_id but never thread_ts.
        // That's harmless in the common case (a DM under the default
        // dmSessionMode "channel" session), but it means this command has
        // nothing it could correctly target in a non-DM channel (always
        // thread-scoped) or in a DM under dmSessionMode "thread" (also
        // thread-scoped — see resolveSessionScope). Point at the mechanism
        // that works instead of reporting a misleading "no session to reset"
        // while a real, thread-scoped session sits invisibly out of reach.
        if (!isDmChannelId(cmd.channel) || cfg.dmSessionMode === "thread") {
          await gateway.postEphemeral({
            channel: cmd.channel,
            user: cmd.user,
            text: THREAD_SCOPED_RESET_POINTER,
          });
          return;
        }
        const key = STATE_KEYS.session(cmd.channel, CHANNEL_SESSION_TS);
        let cleared: boolean;
        try {
          cleared = await resetSession(ctx, cfg, key, "command");
        } catch (err) {
          ctx.logger.warn("Slash reset failed", { err: errString(err), channel: cmd.channel });
          await ctx.metrics.write("slack.commands.failed", 1, { subcommand }).catch(() => {});
          await gateway.postEphemeral({
            channel: cmd.channel,
            user: cmd.user,
            text: ":x: Failed to reset the conversation. Check the plugin configuration.",
          });
          return;
        }
        await gateway.postEphemeral({
          channel: cmd.channel,
          user: cmd.user,
          text: cleared
            ? ":broom: Conversation reset — the next message starts fresh."
            : "Nothing to reset — this conversation is already fresh.",
        });
        return;
      }

      if (sub === "issue") {
        const title = rest.join(" ").trim();
        if (!title) {
          await gateway.postEphemeral({
            channel: cmd.channel, user: cmd.user, text: "Usage: `/paperclip issue <title>`",
          });
          return;
        }
        let issue: Awaited<ReturnType<typeof ctx.issues.create>>;
        try {
          issue = await ctx.issues.create({ companyId: cfg.companyId, title, status: "todo" });
        } catch (err) {
          ctx.logger.warn("Slash issue creation failed", { err: errString(err) });
          await ctx.metrics.write("slack.commands.failed", 1, { subcommand }).catch(() => {});
          await gateway.postEphemeral({
            channel: cmd.channel,
            user: cmd.user,
            text: ":x: Failed to create the issue. Check the plugin configuration.",
          });
          return;
        }
        // The issue now exists even if this confirmation fails (e.g. the bot
        // isn't a member of the channel) — never report a false "Failed" for
        // a success ephemeral failure.
        try {
          await gateway.postEphemeral({
            channel: cmd.channel,
            user: cmd.user,
            text: `:white_check_mark: Created issue: ${cfg.paperclipBaseUrl}/issues/${issue.id}`,
          });
        } catch (err) {
          ctx.logger.warn("Slash issue confirmation ephemeral failed (issue was created)", {
            err: errString(err),
            issueId: issue.id,
          });
        }
        return;
      }
      await gateway.postEphemeral({ channel: cmd.channel, user: cmd.user, text: HELP });
    },
  };
}
