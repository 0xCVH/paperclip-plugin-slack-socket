import {
  definePlugin,
  runWorker,
  type PluginContext,
  type PluginHealthDiagnostics,
} from "@paperclipai/plugin-sdk";
import { createApprovals, type Approvals } from "./approvals.js";
import { createAskHuman, type AskHuman } from "./ask-human.js";
import { BoltGateway } from "./bolt-gateway.js";
import { createChat, type Chat } from "./chat.js";
import { runCleanup } from "./cleanup.js";
import { createCommands, type Commands } from "./commands.js";
import { mergeConfig } from "./config.js";
import { DEFAULT_CONFIG, JOB_KEYS, SLASH_COMMAND } from "./constants.js";
import { createEventDeduper } from "./event-dedup.js";
import { createGatewayProxy } from "./gateway-proxy.js";
import { registerNotifications } from "./notifications.js";
import { errString } from "./redact.js";
import type { SlackGateway, SlackSocketConfig } from "./types.js";

export type GatewayFactory = (opts: { botToken: string; appToken: string }) => SlackGateway;

type Health = PluginHealthDiagnostics & { message?: string };

const REQUIRED_FIELDS = ["slackBotTokenRef", "slackAppTokenRef", "companyId", "defaultAgentId"] as const;

interface Modules {
  chat: Chat;
  askHuman: AskHuman;
  approvals: Approvals;
  commands: Commands;
  gatewayProxy: SlackGateway;
}

// --- Module-level runtime state ---------------------------------------
//
// This plugin is "proactive": all of its work happens in Socket Mode
// callbacks, timers, and `setup()` — never inside a host-issued invocation.
// Outside an invocation the host can only resolve company scope from an
// explicit `companyId` passed on the call, so there is no per-call config
// or gateway to thread through — the host instead *pushes* config to us via
// `onConfigChanged` (once per configured company right after startup, and
// again on every operator save). We cache the most recent config and the
// live gateway here at module scope and read them everywhere else.
let health: Health = { status: "degraded", message: "Waiting for configuration" };
let liveConfig: SlackSocketConfig | null = null;
let currentGateway: SlackGateway | null = null;
let lastCtx: PluginContext | null = null;
let modules: Modules | null = null;

/** The most recently applied config, or DEFAULT_CONFIG before any has arrived. */
export function getLiveConfig(): SlackSocketConfig {
  return liveConfig ?? DEFAULT_CONFIG;
}

// Registration that must happen exactly once per worker process: ctx.events
// subscriptions, the ask_human tool registration, and (from setup()) the
// cleanup job. All of it is wired against a gateway *proxy* (see
// gateway-proxy.ts) because the real gateway doesn't exist yet — `setup()`
// runs once, before any config has arrived, and registration must complete
// synchronously within it. The proxy lets these modules — and in
// particular a single, stable `askHuman` instance for both the tool and
// the socket event paths — be built once and simply start working once a
// real gateway shows up.
function ensureModules(ctx: PluginContext): Modules {
  if (modules) return modules;
  const gatewayProxy = createGatewayProxy(() => currentGateway, ctx.logger);
  const getConfig = async (): Promise<SlackSocketConfig> => getLiveConfig();

  const chat = createChat({ ctx, gateway: gatewayProxy, getConfig });
  const askHuman = createAskHuman({ ctx, gateway: gatewayProxy });
  const approvals = createApprovals({ ctx, gateway: gatewayProxy, getConfig });
  const commands = createCommands({ ctx, gateway: gatewayProxy, getConfig });
  registerNotifications({ ctx, gateway: gatewayProxy, getConfig });
  askHuman.registerTool();

  modules = { chat, askHuman, approvals, commands, gatewayProxy };
  return modules;
}

/**
 * Apply a fully-merged config: tear down any existing gateway, validate the
 * required fields, resolve the Slack secrets scoped to `cfg.companyId`
 * (required outside an invocation — this is the fix for the bug where
 * `secrets.resolve` failed with "company context is required"), stand up a
 * new gateway via the injected `makeGateway` factory, and wire the socket
 * handlers to the modules built by `ensureModules`.
 *
 * This is the seam worker tests use to drive the full lifecycle with a
 * `FakeGateway`, without a real Bolt App. `onConfigChanged` (the real,
 * host-facing hook) and `startRuntime` (kept for tests) are both thin
 * wrappers around this.
 */
export async function applyConfig(
  ctx: PluginContext,
  cfg: SlackSocketConfig,
  makeGateway: GatewayFactory,
): Promise<Health> {
  liveConfig = cfg;
  const { chat, askHuman, approvals, commands } = ensureModules(ctx);

  if (currentGateway) {
    await currentGateway.stop().catch(() => {});
    currentGateway = null;
  }

  const missing = REQUIRED_FIELDS.filter((field) => !cfg[field]);
  if (missing.length > 0) {
    health = { status: "degraded", message: `Slack Socket plugin not configured: missing ${missing.join(", ")}` };
    ctx.logger.warn("Slack Socket plugin not configured; runtime disabled", { missing });
    return health;
  }

  let botToken: string;
  let appToken: string;
  try {
    botToken = await ctx.secrets.resolve(cfg.slackBotTokenRef, { companyId: cfg.companyId });
    appToken = await ctx.secrets.resolve(cfg.slackAppTokenRef, { companyId: cfg.companyId });
  } catch (err) {
    health = { status: "degraded", message: "Failed to resolve Slack token secrets; check the secret references" };
    ctx.logger.error("Slack token secret resolution failed", { err: errString(err) });
    return health;
  }

  const gateway = makeGateway({ botToken, appToken });

  // Slack Socket Mode redelivers events at-least-once, and a reconnect can
  // replay a backlog of stale events. Dedupe/stale-filter mention and
  // message dispatch before it reaches ask-human's answer routing or chat —
  // reactions, actions, and commands are not deduped (they're not prone to
  // the same at-least-once redelivery pattern here and are already
  // effectively idempotent or externally acked). Keys are namespaced by
  // event type ("mention:"/"message:") because a single channel @mention
  // arrives as two distinct Slack events sharing the same ts (app_mention +
  // message.channels) — without the prefix, consuming one event's key would
  // shadow the other's and silently drop it as a "duplicate". Rebuilt fresh
  // per gateway, since a new Socket Mode connection means a fresh
  // redelivery/replay risk.
  const eventDeduper = createEventDeduper();
  gateway.onMention(async (msg) => {
    if (!eventDeduper.shouldProcess(`mention:${msg.channel}:${msg.ts}`)) return;
    await chat.handleMention(msg);
  });
  gateway.onMessage(async (msg) => {
    if (!eventDeduper.shouldProcess(`message:${msg.channel}:${msg.ts}`)) return;
    if (await askHuman.tryHandleAnswer(msg)) return;
    await chat.handleMessage(msg);
  });
  gateway.onReaction((reaction) => askHuman.handleReaction(reaction));
  gateway.onAction(/^approval_(approve|reject)$/, (action) => approvals.handleAction(action));
  gateway.onCommand(SLASH_COMMAND, (cmd) => commands.handleCommand(cmd));

  currentGateway = gateway;
  await gateway.start();
  health = { status: "ok" };
  ctx.logger.info("Slack Socket Mode connected");
  return health;
}

/** Test seam kept for back-compat: applies an explicit config via `applyConfig`. */
export async function startRuntime(
  ctx: PluginContext,
  makeGateway: GatewayFactory,
  cfg: SlackSocketConfig,
): Promise<Health> {
  return applyConfig(ctx, cfg, makeGateway);
}

const plugin = definePlugin({
  async setup(ctx) {
    lastCtx = ctx;
    ensureModules(ctx);
    ctx.jobs.register(JOB_KEYS.cleanup, async () => {
      if (!currentGateway) return;
      const { gatewayProxy } = ensureModules(ctx);
      await runCleanup(ctx, gatewayProxy, getLiveConfig());
    });
  },

  async onConfigChanged(config) {
    if (!lastCtx) return;
    const ctx = lastCtx;
    try {
      await applyConfig(ctx, mergeConfig(config), (opts) => new BoltGateway({ ...opts, logger: ctx.logger }));
    } catch (err) {
      health = { status: "degraded", message: `Slack Socket configuration failed: ${errString(err)}` };
      ctx.logger.error("Slack Socket onConfigChanged failed", { err: errString(err) });
    }
  },

  async onShutdown() {
    await currentGateway?.stop().catch(() => {});
  },

  async onHealth() {
    if (!liveConfig) return { status: "degraded", message: "Waiting for configuration" };
    if (health.status !== "ok") return health;
    if (currentGateway && !currentGateway.isConnected()) {
      return { status: "degraded", message: "Slack Socket Mode disconnected; Bolt is reconnecting" };
    }
    return { status: "ok" };
  },

  async onValidateConfig(config) {
    const cfg = mergeConfig(config);
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
      errors.push(`Validation unavailable: ${errString(err)}`);
      return { ok: false, errors };
    }

    // companyId comes from the config object passed into this hook (via
    // mergeConfig above), not the cached liveConfig — the host may be
    // validating a not-yet-saved edit for a company whose config hasn't
    // been applied yet, so the cached value could be stale or absent.
    try {
      const botToken = await lastCtx.secrets.resolve(cfg.slackBotTokenRef, { companyId: cfg.companyId });
      const auth = await new WebClient(botToken).auth.test();
      if (!auth.ok) errors.push("Slack auth.test failed for the bot token");
    } catch (err) {
      errors.push(`Bot token check failed: ${errString(err)}`);
    }
    try {
      const appToken = await lastCtx.secrets.resolve(cfg.slackAppTokenRef, { companyId: cfg.companyId });
      const conn = await new WebClient(appToken).apps.connections.open();
      if (!conn.ok) errors.push("apps.connections.open failed for the app token (needs connections:write)");
    } catch (err) {
      errors.push(`App token check failed: ${errString(err)}`);
    }
    return { ok: errors.length === 0, errors };
  },
});

export default plugin;
runWorker(plugin, import.meta.url);
