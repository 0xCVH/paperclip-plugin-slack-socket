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
import { describeHostError } from "./host-errors.js";
import type { SlackGateway, SlackSocketConfig } from "./types.js";

export type GatewayFactory = (opts: { botToken: string; appToken: string }) => SlackGateway;

type Health = PluginHealthDiagnostics & { message?: string };

const REQUIRED_FIELDS = ["slackBotTokenRef", "slackAppTokenRef", "companyId", "defaultAgentId"] as const;


// Modules that need no company scope: built once in setup(), against the
// gateway proxy, before any config has arrived.
interface CoreModules {
  chat: Chat;
  askHuman: AskHuman;
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
let coreModules: CoreModules | null = null;
let approvals: Approvals | null = null;

// This plugin binds to exactly one company for the lifetime of the worker
// process: the first company whose config successfully applies. The host
// runs one worker process per installed plugin, shared by every company
// that configures it, and drops the RPC-level companyId — the only company
// identifier available is the operator-typed `companyId` field inside the
// config object itself. Without this guard, a second company's config would
// tear down the first company's Slack socket and start posting company A's
// notifications into company B's workspace.
let boundCompanyId: string | null = null;
// Non-null when a mismatched-company config has been refused; surfaced via
// onHealth so the conflict is visible without digging through logs. Cleared
// whenever a config for the bound company applies successfully.
let tenantConflict: string | null = null;
// Guards ctx.events.on(...) subscriptions (in registerNotifications and
// createApprovals) so they're only wired up once, on the first successful
// bind — that's the earliest point a companyId is known to filter them by.
let eventsSubscribed = false;

/** The most recently applied config, or DEFAULT_CONFIG before any has arrived. */
export function getLiveConfig(): SlackSocketConfig {
  return liveConfig ?? DEFAULT_CONFIG;
}

// Registration that must happen exactly once per worker process regardless
// of company: the ask_human tool registration and (from setup()) the
// cleanup job. All of it is wired against a gateway *proxy* (see
// gateway-proxy.ts) because the real gateway doesn't exist yet — `setup()`
// runs once, before any config has arrived, and registration must complete
// synchronously within it. The proxy lets these modules — and in
// particular a single, stable `askHuman` instance for both the tool and
// the socket event paths — be built once and simply start working once a
// real gateway shows up.
function ensureCoreModules(ctx: PluginContext): CoreModules {
  if (coreModules) return coreModules;
  const gatewayProxy = createGatewayProxy(() => currentGateway, ctx.logger);
  const getConfig = async (): Promise<SlackSocketConfig> => getLiveConfig();

  const chat = createChat({ ctx, gateway: gatewayProxy, getConfig });
  const askHuman = createAskHuman({ ctx, gateway: gatewayProxy });
  const commands = createCommands({ ctx, gateway: gatewayProxy, getConfig });
  askHuman.registerTool();

  coreModules = { chat, askHuman, commands, gatewayProxy };
  return coreModules;
}

// Registration that must happen exactly once per worker process *and* is
// scoped to the single company this worker is bound to: the `ctx.events.on`
// subscriptions in notifications.ts and approvals.ts. These can only be
// wired once a companyId is known, so — unlike `ensureCoreModules` — this
// runs from the first successful `applyConfig` bind rather than from
// `setup()`. Guarded by `eventsSubscribed` so a later same-company
// reconfiguration never double-subscribes.
function ensureCompanyModules(ctx: PluginContext, companyId: string): Approvals {
  const { gatewayProxy } = ensureCoreModules(ctx);
  const getConfig = async (): Promise<SlackSocketConfig> => getLiveConfig();
  if (!eventsSubscribed) {
    eventsSubscribed = true;
    registerNotifications({ ctx, gateway: gatewayProxy, getConfig, companyId });
    approvals = createApprovals({ ctx, gateway: gatewayProxy, getConfig, companyId });
  }
  // Set on the same first-bind path that flips `eventsSubscribed`, so it is
  // always non-null here.
  return approvals!;
}

/**
 * Apply a fully-merged config: validate the required fields, resolve the
 * Slack secrets scoped to `cfg.companyId` (required outside an invocation —
 * this is the fix for the bug where `secrets.resolve` failed with "company
 * context is required"), and only then — once validation has fully
 * succeeded — tear down any existing gateway, commit `cfg` as the live
 * config, stand up a new gateway via the injected `makeGateway` factory, and
 * wire the socket handlers to the modules built by `ensureCoreModules` /
 * `ensureCompanyModules`.
 *
 * Validating before tearing down matters because this worker process is
 * shared by every company that has this plugin installed: a bad config
 * (typo'd secret ref, revoked token, etc.) must never take down a
 * previously-working connection. On failure the previous `liveConfig` and
 * `currentGateway` are left completely untouched.
 *
 * This also enforces single-tenant binding: the host runs one worker
 * process per installed plugin, shared by every company that configures it,
 * and drops the RPC-level companyId, so the operator-typed `companyId`
 * field inside the config is the only company identifier available. The
 * first config to successfully apply binds this process to that company for
 * its lifetime; a config for any other company is refused outright so it
 * can never tear down company A's socket or leak company A's notifications
 * into company B's workspace.
 *
 * The binding itself is claimed synchronously (before any `await`), not
 * after the async validation/setup work completes — see the "claim-then-
 * verify" comment inline below for why: without it, two overlapping calls
 * for different companies can both observe an unclaimed process and race.
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
  if (boundCompanyId && cfg.companyId !== boundCompanyId) {
    const message =
      `Refusing configuration for company "${cfg.companyId}": this plugin process is already bound to ` +
      `company "${boundCompanyId}". The Slack Socket plugin is single-tenant — one Slack workspace ` +
      `connection is supported per installed plugin process — so this config was ignored; the existing ` +
      `connection for "${boundCompanyId}" is unaffected.`;
    tenantConflict = message;
    ctx.logger.error("Slack Socket plugin: refusing cross-tenant config change", {
      boundCompanyId,
      incomingCompanyId: cfg.companyId,
    });
    // Per contract: leave `health` untouched (it still reflects the bound
    // company's actual gateway/connection state); this is only the return
    // value for direct callers of applyConfig.
    return { status: "degraded", message };
  }

  // Claim-then-verify: the SDK's RPC dispatcher does not serialize
  // overlapping `configChanged` calls, so two calls for DIFFERENT companies
  // can both reach the mismatch guard above while `boundCompanyId` is still
  // null and both pass it. To close that race, claim the binding
  // synchronously right here — no `await` has happened yet in this call, so
  // this line is guaranteed to run before any other in-flight call can
  // observe or mutate `boundCompanyId`. Whichever call's synchronous prefix
  // (mismatch guard + this claim) runs first wins the binding; every other
  // concurrent call for a different company will now fail the mismatch
  // guard above instead of racing through the awaits below.
  //
  // `didClaim` tracks whether *this* call performed the claim (as opposed
  // to finding the company already bound, i.e. a same-company
  // reconfiguration). Only the call that actually claimed the binding is
  // allowed to roll it back on failure below — a reconfiguration must never
  // null out a binding it didn't create, which could otherwise let a
  // concurrent different-company call sneak in while this one is still
  // failing.
  const didClaim = boundCompanyId === null;
  if (didClaim) boundCompanyId = cfg.companyId;

  // Fix: clear any stale cross-tenant conflict as soon as we know this call
  // is not being refused for tenancy (i.e. it's for the bound company) —
  // otherwise a later failure for the bound company (missing fields, bad
  // secrets, etc.) would still be masked by an older cross-tenant refusal
  // message in onHealth.
  tenantConflict = null;

  const missing = REQUIRED_FIELDS.filter((field) => !cfg[field]);
  if (missing.length > 0) {
    health = liveConfig
      ? {
          status: "degraded",
          message: `New Slack Socket configuration rejected (missing ${missing.join(", ")}); the previous configuration is still active`,
        }
      : { status: "degraded", message: `Slack Socket plugin not configured: missing ${missing.join(", ")}` };
    ctx.logger.warn("Slack Socket plugin not configured; runtime disabled", { missing });
    if (didClaim) boundCompanyId = null;
    return health;
  }

  let botToken: string;
  let appToken: string;
  try {
    botToken = await ctx.secrets.resolve(cfg.slackBotTokenRef, { companyId: cfg.companyId });
    appToken = await ctx.secrets.resolve(cfg.slackAppTokenRef, { companyId: cfg.companyId });
  } catch (err) {
    health = liveConfig
      ? {
          status: "degraded",
          message:
            "New Slack Socket configuration rejected: failed to resolve Slack token secrets; the previous configuration is still active",
        }
      : { status: "degraded", message: "Failed to resolve Slack token secrets; check the secret references" };
    ctx.logger.error("Slack token secret resolution failed", { err: errString(err) });
    if (didClaim) boundCompanyId = null;
    return health;
  }

  // Validation succeeded: safe to commit. Build/reuse the company-scoped
  // modules (subscribing ctx.events on the first successful bind only),
  // tear down the previous gateway, and commit the new config.
  const { chat, askHuman, commands } = ensureCoreModules(ctx);
  const approvals = ensureCompanyModules(ctx, cfg.companyId);

  if (currentGateway) {
    await currentGateway.stop().catch(() => {});
    currentGateway = null;
  }
  liveConfig = cfg;

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
  try {
    await gateway.start();
  } catch (err) {
    // Roll back the claim (if we made one) so a later, valid config for a
    // different company isn't permanently blocked by this failed bind.
    // Note liveConfig/currentGateway have already been committed above by
    // this point — that half of "leave things intact on failure" only
    // applies to the validation failures above, before teardown began.
    if (didClaim) boundCompanyId = null;
    throw err;
  }
  // `boundCompanyId` is already set (either freshly claimed above, or
  // pre-existing for a same-company reconfiguration) — no further
  // assignment needed here. `tenantConflict` is cleared again at this tail
  // (as well as at the top): a different-company config refused while this
  // apply was in flight would otherwise leave onHealth() reporting a stale
  // conflict even though this bind succeeded.
  tenantConflict = null;
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
    ensureCoreModules(ctx);
    ctx.jobs.register(JOB_KEYS.cleanup, async () => {
      if (!currentGateway) return;
      const { gatewayProxy } = ensureCoreModules(ctx);
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
    if (tenantConflict) return { status: "degraded", message: tenantConflict };
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
      errors.push(`Bot token check failed: ${describeHostError(err)}`);
    }
    try {
      const appToken = await lastCtx.secrets.resolve(cfg.slackAppTokenRef, { companyId: cfg.companyId });
      const conn = await new WebClient(appToken).apps.connections.open();
      if (!conn.ok) errors.push("apps.connections.open failed for the app token (needs connections:write)");
    } catch (err) {
      errors.push(`App token check failed: ${describeHostError(err)}`);
    }
    return { ok: errors.length === 0, errors };
  },
});

export default plugin;
runWorker(plugin, import.meta.url);
