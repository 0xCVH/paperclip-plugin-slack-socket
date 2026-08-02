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

          // getConfig() carries no non-throwing guarantee (it's a plain
          // Promise-returning function on PostMessageDeps), so a rejection
          // here must not propagate out of the tool handler — tool handlers
          // never throw. Wrapped the same way the Slack calls below are.
          let config: SlackSocketConfig;
          try {
            config = await getConfig();
          } catch (err) {
            return { error: `Failed to load Slack posting configuration: ${errString(err)}` };
          }

          const decision = checkPostTarget(config, target);
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

          let channel: string;
          let first: { channel: string; ts: string };
          try {
            channel = decision.kind === "dm" ? await gateway.openDm(decision.target) : decision.target;
            first = await gateway.postMessage({ channel, threadTs, text: head });
          } catch (err) {
            // Nothing was posted (openDm or the head post itself failed) —
            // this is a clean failure with no partial state to report.
            return { error: `Failed to post message to Slack: ${errString(err)}` };
          }

          // Overflow goes into a thread rather than as more top-level
          // messages: an agent posting something long shouldn't take over
          // the channel. When the caller already gave a threadTs, stay in
          // that thread instead of nesting under our own first message.
          //
          // The head chunk is already live in Slack by this point, so a
          // failure partway through the remaining chunks must NOT be
          // reported as a plain `{ error }` — that would tell the calling
          // agent nothing posted, when part of the message is actually
          // sitting in the channel. Returning a bare error here would also
          // invite a naive retry that duplicates the head chunk. Instead,
          // report a success-shaped result whose `content` states the truth
          // (how many parts landed vs. the total) and whose `data` points at
          // the head message so the agent knows what's live and where. We
          // deliberately do not attempt to delete/roll back the already-
          // posted chunks.
          let postedCount = 1;
          for (const extra of rest) {
            try {
              await gateway.postMessage({ channel, threadTs: threadTs ?? first.ts, text: extra });
              postedCount++;
            } catch (err) {
              const totalParts = rest.length + 1;
              ctx.logger.error(
                "slack_post_message: message split into multiple parts, but a continuation part failed to post after the first part already went live",
                { channel: first.channel, ts: first.ts, postedParts: postedCount, totalParts, err: errString(err) },
              );
              await writeMetric("slack.messages.posted", { kind: decision.kind, partial: "true" });
              return {
                content:
                  `Message posted to Slack channel ${first.channel}, but only ${postedCount} of ${totalParts} ` +
                  `parts sent — the rest failed: ${errString(err)}`,
                data: { channel: first.channel, ts: first.ts },
              };
            }
          }

          await writeMetric("slack.messages.posted", { kind: decision.kind });
          return {
            content: `Message posted to Slack channel ${first.channel}.`,
            data: { channel: first.channel, ts: first.ts },
          };
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
