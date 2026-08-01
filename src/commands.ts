import type { PluginContext } from "@paperclipai/plugin-sdk";
import { errString } from "./redact.js";
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
  "• `/paperclip help` — show this help",
].join("\n");

export function createCommands({ ctx, gateway, getConfig }: CommandDeps): Commands {
  return {
    async handleCommand(cmd) {
      const cfg = await getConfig();
      const [sub, ...rest] = cmd.text.trim().split(/\s+/);
      const subcommand = sub === "issue" ? "issue" : "help";
      await ctx.metrics.write("slack.commands.invoked", 1, { subcommand }).catch(() => {});
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
