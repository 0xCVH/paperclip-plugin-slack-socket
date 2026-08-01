import type { PluginContext } from "@paperclipai/plugin-sdk";
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
      if (sub === "issue") {
        const title = rest.join(" ").trim();
        if (!title) {
          await gateway.postEphemeral({
            channel: cmd.channel, user: cmd.user, text: "Usage: `/paperclip issue <title>`",
          });
          return;
        }
        try {
          const issue = await ctx.issues.create({ companyId: cfg.companyId, title, status: "todo" });
          await gateway.postEphemeral({
            channel: cmd.channel,
            user: cmd.user,
            text: `:white_check_mark: Created issue: ${cfg.paperclipBaseUrl}/issues/${issue.id}`,
          });
        } catch (err) {
          ctx.logger.warn("Slash issue creation failed", { err: String(err) });
          await gateway.postEphemeral({
            channel: cmd.channel,
            user: cmd.user,
            text: ":x: Failed to create the issue. Check the plugin configuration.",
          });
        }
        return;
      }
      await gateway.postEphemeral({ channel: cmd.channel, user: cmd.user, text: HELP });
    },
  };
}
