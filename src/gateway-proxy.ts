import type {
  InboundAction,
  InboundCommand,
  InboundMessage,
  InboundReaction,
  OutboundMessage,
  SlackGateway,
} from "./types.js";

export interface GatewayProxyLogger {
  warn(message: string, data?: Record<string, unknown>): void;
}

/**
 * A `SlackGateway`-shaped proxy that delegates every call to whatever
 * gateway `getGateway()` currently returns, and safely no-ops (logging a
 * warning) when there isn't one yet — e.g. before the plugin's first
 * `onConfigChanged` call, or while it's degraded after a bad config change.
 *
 * This exists so modules that need a `SlackGateway` at construction time
 * (notifications, the `ask_human` tool, approvals, commands) can be built
 * exactly once in `setup()` — before any concrete gateway exists — instead
 * of being torn down and rebuilt on every config change. In particular, the
 * `ask_human` tool is registered once and must keep working (posting
 * questions, resolving answers) against the *same* module instance across
 * gateway swaps.
 *
 * `postMessage` is the one method that doesn't just no-op: every caller
 * uses its return value (e.g. to record the posted message's channel/ts),
 * so a silent no-op would surface as a confusing downstream crash instead
 * of a clear error. It throws instead — callers already handle that, e.g.
 * the `ask_human` tool's handler returns `{ error }` when its post throws.
 */
export function createGatewayProxy(
  getGateway: () => SlackGateway | null,
  logger: GatewayProxyLogger,
): SlackGateway {
  const warnUnconfigured = (method: string): void => {
    logger.warn(`Slack gateway.${method} called before the plugin is configured; ignoring`, { method });
  };

  return {
    async start() {
      const gateway = getGateway();
      if (!gateway) {
        warnUnconfigured("start");
        return;
      }
      await gateway.start();
    },

    async stop() {
      const gateway = getGateway();
      if (!gateway) {
        warnUnconfigured("stop");
        return;
      }
      await gateway.stop();
    },

    isConnected() {
      return getGateway()?.isConnected() ?? false;
    },

    botUserId() {
      return getGateway()?.botUserId();
    },

    async postMessage(msg: OutboundMessage) {
      const gateway = getGateway();
      if (!gateway) {
        warnUnconfigured("postMessage");
        throw new Error("Slack gateway is not configured yet");
      }
      return gateway.postMessage(msg);
    },

    async updateMessage(msg) {
      const gateway = getGateway();
      if (!gateway) {
        warnUnconfigured("updateMessage");
        return;
      }
      await gateway.updateMessage(msg);
    },

    async postEphemeral(msg) {
      const gateway = getGateway();
      if (!gateway) {
        warnUnconfigured("postEphemeral");
        return;
      }
      await gateway.postEphemeral(msg);
    },

    async openDm(userId: string) {
      const gateway = getGateway();
      if (!gateway) {
        warnUnconfigured("openDm");
        return "";
      }
      return gateway.openDm(userId);
    },

    async getUserDisplayName(userId: string) {
      const gateway = getGateway();
      if (!gateway) {
        warnUnconfigured("getUserDisplayName");
        return userId;
      }
      return gateway.getUserDisplayName(userId);
    },

    onMessage(handler: (msg: InboundMessage) => Promise<void>) {
      const gateway = getGateway();
      if (!gateway) {
        warnUnconfigured("onMessage");
        return;
      }
      gateway.onMessage(handler);
    },

    onMention(handler: (msg: InboundMessage) => Promise<void>) {
      const gateway = getGateway();
      if (!gateway) {
        warnUnconfigured("onMention");
        return;
      }
      gateway.onMention(handler);
    },

    onReaction(handler: (r: InboundReaction) => Promise<void>) {
      const gateway = getGateway();
      if (!gateway) {
        warnUnconfigured("onReaction");
        return;
      }
      gateway.onReaction(handler);
    },

    onAction(pattern: RegExp, handler: (a: InboundAction) => Promise<void>) {
      const gateway = getGateway();
      if (!gateway) {
        warnUnconfigured("onAction");
        return;
      }
      gateway.onAction(pattern, handler);
    },

    onCommand(command: string, handler: (c: InboundCommand) => Promise<void>) {
      const gateway = getGateway();
      if (!gateway) {
        warnUnconfigured("onCommand");
        return;
      }
      gateway.onCommand(command, handler);
    },
  };
}
