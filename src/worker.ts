import {
  definePlugin,
  runWorker,
  type PluginContext,
  type PluginHealthDiagnostics,
} from "@paperclipai/plugin-sdk";
import { createApprovals } from "./approvals.js";
import { createAskHuman } from "./ask-human.js";
import { BoltGateway } from "./bolt-gateway.js";
import { createChat } from "./chat.js";
import { runCleanup } from "./cleanup.js";
import { createCommands } from "./commands.js";
import { loadConfig } from "./config.js";
import { DEFAULT_CONFIG, JOB_KEYS, SLASH_COMMAND } from "./constants.js";
import { registerNotifications } from "./notifications.js";
import type { SlackGateway, SlackSocketConfig } from "./types.js";

export type GatewayFactory = (opts: { botToken: string; appToken: string }) => SlackGateway;

type Health = PluginHealthDiagnostics & { message?: string };

const REQUIRED_FIELDS = ["slackBotTokenRef", "slackAppTokenRef", "companyId", "defaultAgentId"] as const;

let health: Health = { status: "ok" };
let gateway: SlackGateway | null = null;
let lastCtx: PluginContext | null = null;

export async function startRuntime(ctx: PluginContext, makeGateway: GatewayFactory): Promise<Health> {
  const cfg = await loadConfig(ctx);

  const missing = REQUIRED_FIELDS.filter((field) => !cfg[field]);
  if (missing.length > 0) {
    health = { status: "degraded", message: `Slack Socket plugin not configured: missing ${missing.join(", ")}` };
    ctx.logger.warn("Slack Socket plugin not configured; runtime disabled", { missing });
    return health;
  }

  let botToken: string;
  let appToken: string;
  try {
    botToken = await ctx.secrets.resolve(cfg.slackBotTokenRef);
    appToken = await ctx.secrets.resolve(cfg.slackAppTokenRef);
  } catch (err) {
    health = { status: "degraded", message: "Failed to resolve Slack token secrets; check the secret references" };
    ctx.logger.error("Slack token secret resolution failed", { err: String(err) });
    return health;
  }

  gateway = makeGateway({ botToken, appToken });
  const getConfig = (): Promise<SlackSocketConfig> => loadConfig(ctx);

  const chat = createChat({ ctx, gateway, getConfig });
  const askHuman = createAskHuman({ ctx, gateway });
  const approvals = createApprovals({ ctx, gateway, getConfig });
  const commands = createCommands({ ctx, gateway, getConfig });
  registerNotifications({ ctx, gateway, getConfig });
  askHuman.registerTool();

  gateway.onMention((msg) => chat.handleMention(msg));
  gateway.onMessage(async (msg) => {
    if (await askHuman.tryHandleAnswer(msg)) return;
    await chat.handleMessage(msg);
  });
  gateway.onReaction((reaction) => askHuman.handleReaction(reaction));
  gateway.onAction(/^approval_(approve|reject)$/, (action) => approvals.handleAction(action));
  gateway.onCommand(SLASH_COMMAND, (cmd) => commands.handleCommand(cmd));

  ctx.jobs.register(JOB_KEYS.cleanup, async () => {
    if (!gateway) return;
    await runCleanup(ctx, gateway, await loadConfig(ctx));
  });

  await gateway.start();
  health = { status: "ok" };
  ctx.logger.info("Slack Socket Mode connected");
  return health;
}

const plugin = definePlugin({
  async setup(ctx) {
    lastCtx = ctx;
    try {
      await startRuntime(ctx, (opts) => new BoltGateway({ ...opts, logger: ctx.logger }));
    } catch (err) {
      health = { status: "degraded", message: `Slack Socket startup failed: ${String(err)}` };
      ctx.logger.error("Slack Socket startup failed", { err: String(err) });
    }
  },

  async onShutdown() {
    await gateway?.stop().catch(() => {});
  },

  async onHealth() {
    if (health.status !== "ok") return health;
    if (gateway && !gateway.isConnected()) {
      return { status: "degraded", message: "Slack Socket Mode disconnected; Bolt is reconnecting" };
    }
    return { status: "ok" };
  },

  async onValidateConfig(config) {
    const cfg: SlackSocketConfig = { ...DEFAULT_CONFIG, ...(config as Partial<SlackSocketConfig>) };
    const errors: string[] = [];
    for (const field of [...REQUIRED_FIELDS, "defaultChannelId"] as const) {
      if (!cfg[field]) errors.push(`${field} is required`);
    }
    if (errors.length > 0) return { ok: false, errors };
    if (!lastCtx) {
      return { ok: false, errors: ["Validation unavailable: plugin context not initialized"] };
    }

    let WebClient: typeof import("@slack/web-api").WebClient;
    try {
      ({ WebClient } = await import("@slack/web-api"));
    } catch (err) {
      errors.push(`Validation unavailable: ${String(err)}`);
      return { ok: false, errors };
    }

    try {
      const botToken = await lastCtx.secrets.resolve(cfg.slackBotTokenRef);
      const auth = await new WebClient(botToken).auth.test();
      if (!auth.ok) errors.push("Slack auth.test failed for the bot token");
    } catch (err) {
      errors.push(`Bot token check failed: ${String(err)}`);
    }
    try {
      const appToken = await lastCtx.secrets.resolve(cfg.slackAppTokenRef);
      const conn = await new WebClient(appToken).apps.connections.open();
      if (!conn.ok) errors.push("apps.connections.open failed for the app token (needs connections:write)");
    } catch (err) {
      errors.push(`App token check failed: ${String(err)}`);
    }
    return { ok: errors.length === 0, errors };
  },
});

export default plugin;
runWorker(plugin, import.meta.url);
