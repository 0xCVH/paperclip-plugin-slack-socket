import type { PluginContext } from "@paperclipai/plugin-sdk";
import { checkPostTarget } from "./access.js";
import { POST_MESSAGE_TOOL_DECLARATION, TOOL_NAMES } from "./constants.js";
import { escapeMrkdwn } from "./formatters.js";
import { markdownToMrkdwn } from "./mrkdwn.js";
import { errString } from "./redact.js";
import { MAX_MESSAGE_LENGTH, splitIntoChunks } from "./slack-text.js";
import type { SlackGateway, SlackSocketConfig } from "./types.js";

export interface PostMessageDeps {
  ctx: PluginContext;
  gateway: SlackGateway;
  getConfig: () => Promise<SlackSocketConfig>;
}

export interface PostMessage {
  registerTool(): void;
}

export function createPostMessage({ ctx, gateway, getConfig }: PostMessageDeps): PostMessage {
  return {
    registerTool() {
      ctx.tools.register(
        TOOL_NAMES.postMessage,
        {
          displayName: POST_MESSAGE_TOOL_DECLARATION.displayName,
          description: POST_MESSAGE_TOOL_DECLARATION.description,
          parametersSchema: POST_MESSAGE_TOOL_DECLARATION.parametersSchema,
        },
        async (params) => {
          const p = (params ?? {}) as Record<string, unknown>;
          const target = typeof p.target === "string" ? p.target.trim() : "";
          const text = typeof p.text === "string" ? p.text.trim() : "";
          const rawThreadTs = typeof p.threadTs === "string" ? p.threadTs.trim() : "";
          const threadTs = rawThreadTs.length > 0 ? rawThreadTs : undefined;
          if (!target || !text) return { error: "target and text are required" };

          const decision = checkPostTarget(await getConfig(), target);
          if (!decision.allowed) {
            await writeMetric("slack.messages.refused", {});
            return { error: decision.reason };
          }

          // Escape BEFORE converting. Escaping the raw text removes the
          // agent's ability to emit Slack's control sequences directly —
          // <!channel>/<!here> mass-pings, or a hand-authored
          // <https://evil|Payroll> whose visible text hides where it goes —
          // while the conversion afterwards still turns the agent's own
          // [text](url) Markdown into genuine Slack link syntax. Converting
          // first and escaping second would mangle the conversion's output.
          const body = markdownToMrkdwn(escapeMrkdwn(text));
          const [head = body, ...rest] = splitIntoChunks(body, MAX_MESSAGE_LENGTH);

          try {
            const channel =
              decision.kind === "dm" ? await gateway.openDm(decision.target) : decision.target;
            const first = await gateway.postMessage({ channel, threadTs, text: head });
            // Overflow goes into a thread rather than as more top-level
            // messages: an agent posting something long shouldn't take over
            // the channel. When the caller already gave a threadTs, stay in
            // that thread instead of nesting under our own first message.
            for (const extra of rest) {
              await gateway.postMessage({ channel, threadTs: threadTs ?? first.ts, text: extra });
            }
            await writeMetric("slack.messages.posted", { kind: decision.kind });
            return {
              content: `Message posted to Slack channel ${first.channel}.`,
              data: { channel: first.channel, ts: first.ts },
            };
          } catch (err) {
            return { error: `Failed to post message to Slack: ${errString(err)}` };
          }
        },
      );
    },
  };

  async function writeMetric(name: string, tags: Record<string, string>): Promise<void> {
    await ctx.metrics
      .write(name, 1, tags)
      .catch((err) => ctx.logger.warn("Failed to write slack_post_message metrics", { err: errString(err) }));
  }
}
