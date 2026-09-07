import {
  definePlugin,
  runWorker,
  type PluginContext,
  type PluginHealthDiagnostics,
  type PluginApiRequestInput,
  type PluginApiResponse,
} from "@paperclipai/plugin-sdk";
import { isUserAllowed } from "./access.js";
import { createApprovals, type Approvals } from "./approvals.js";
import { createAskHuman, type AskHuman } from "./ask-human.js";
import { BoltGateway } from "./bolt-gateway.js";
import { createChat, type Chat } from "./chat.js";
import { runCleanup } from "./cleanup.js";
import { createCommands, type Commands } from "./commands.js";
import { mergeConfig } from "./config.js";
import { API_ROUTE_KEYS, DEFAULT_CONFIG, JOB_KEYS, PLUGIN_ID, SLASH_COMMAND } from "./constants.js";
import { createEventDeduper } from "./event-dedup.js";
import { createGatewayProxy } from "./gateway-proxy.js";
import { registerNotifications } from "./notifications.js";
import { createPostMessage, type PostMessage } from "./post-message.js";
import { errString } from "./redact.js";
import { describeHostError } from "./host-errors.js";
import type {
  AdditionalSlackBotConfig,
  InboundMessage,
  SlackGateway,
  SlackSocketConfig,
} from "./types.js";

export type GatewayFactory = (opts: { botToken: string; appToken: string }) => SlackGateway;

type Health = PluginHealthDiagnostics & { message?: string };

const REQUIRED_FIELDS = ["slackBotTokenRef", "slackAppTokenRef", "companyId", "defaultAgentId"] as const;


// Modules that need no company scope: built once in setup(), against the
// gateway proxy, before any config has arrived.
interface CoreModules {
  chat: Chat;
  askHuman: AskHuman;
  commands: Commands;
  postMessage: PostMessage;
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
// The most recent config that passed structural validation (required fields
// present, right company), whether or not its apply then succeeded.
// `liveConfig` is committed only after secrets resolve, so a transient
// failure on the FIRST-ever apply leaves liveConfig null — and a watchdog
// gated on liveConfig alone would be permanently inert, waiting on an
// operator to re-save a config the host already pushed. The watchdog falls
// back to this so it can retry that first apply itself. Deliberately NOT
// set for configs that failed validation: re-applying cannot fix a missing
// field, and a cross-tenant config is refused before this is written.
let lastAttemptedConfig: SlackSocketConfig | null = null;
let currentGateway: SlackGateway | null = null;
interface AdditionalBotRuntime {
  key: string;
  config: SlackSocketConfig;
  gateway: SlackGateway;
  chat: Chat;
}
let additionalBotRuntimes = new Map<string, AdditionalBotRuntime>();
let lastCtx: PluginContext | null = null;
let coreModules: CoreModules | null = null;
let approvals: Approvals | null = null;

// Slack Socket Mode redelivers events at-least-once, and a reconnect can
// replay a backlog of stale events. Dedupe/stale-filter mention and
// message dispatch before it reaches ask-human's answer routing or chat —
// reactions, actions, and commands are not deduped (they're not prone to
// the same at-least-once redelivery pattern here and are already
// effectively idempotent or externally acked). Keys are namespaced by
// event type ("mention:"/"message:") because a single channel @mention
// arrives as two distinct Slack events sharing the same ts (app_mention +
// message.channels) — without the prefix, consuming one event's key would
// shadow the other's and silently drop it as a "duplicate". Process-
// lifetime, NOT per-gateway: events redelivered because an envelope ack was
// lost arrive on the NEXT connection — exactly the one a watchdog rebuild
// just created — so a deduper scoped to the gateway would start empty at
// the one moment its memory matters, and each redelivered message would run
// a duplicate agent turn. Keys are channel:ts, so they identify the same
// event across connections.
const eventDeduper = createEventDeduper();

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

// --- Access control -------------------------------------------------------
//
// Gate for every inbound Slack surface (mention, message, reaction, action,
// command): when `allowedSlackUserIds` is non-empty, a user not on it is
// ignored completely — no reply, no ephemeral, no reaction handling, no
// approval decision. Checked before the event-dedup check in the mention/
// message wirings below so a denied event never consumes a dedup key.
type AccessSurface = "mention" | "message" | "reaction" | "action" | "command";

async function checkAccess(
  ctx: PluginContext,
  userId: string,
  surface: AccessSurface,
  cfg: SlackSocketConfig = getLiveConfig(),
  botKey = "primary",
): Promise<boolean> {
  if (isUserAllowed(cfg.allowedSlackUserIds, userId)) return true;
  ctx.logger.info("Ignoring Slack interaction from a user not on the allowlist", { user: userId, surface, botKey });
  const metricTags: Record<string, string> = botKey === "primary" ? { surface } : { surface, botKey };
  await ctx.metrics.write("slack.access.denied", 1, metricTags).catch(() => {});
  return false;
}

type ScopedChatSurface = "mention" | "message";

interface ScopedChatRequest {
  companyId: string;
  botKey?: string;
  surface: ScopedChatSurface;
  message: InboundMessage;
}

function isInboundMessage(value: unknown): value is InboundMessage {
  if (!value || typeof value !== "object") return false;
  const msg = value as Record<string, unknown>;
  return (
    typeof msg.channel === "string" &&
    (msg.channelType === "im" || msg.channelType === "channel" || msg.channelType === "group") &&
    typeof msg.user === "string" &&
    typeof msg.text === "string" &&
    typeof msg.ts === "string" &&
    (msg.threadTs === undefined || typeof msg.threadTs === "string")
  );
}

function parseScopedChatRequest(value: unknown): ScopedChatRequest | null {
  if (!value || typeof value !== "object") return null;
  const body = value as Record<string, unknown>;
  if (typeof body.companyId !== "string") return null;
  if (body.surface !== "mention" && body.surface !== "message") return null;
  if (!isInboundMessage(body.message)) return null;
  return {
    companyId: body.companyId,
    botKey: typeof body.botKey === "string" ? body.botKey : undefined,
    surface: body.surface,
    message: body.message,
  };
}

async function forwardChatThroughScopedRoute(
  cfg: SlackSocketConfig,
  botKey: string,
  surface: ScopedChatSurface,
  message: InboundMessage,
): Promise<void> {
  const url = `${cfg.paperclipBaseUrl.replace(/\/+$/, "")}/api/plugins/${PLUGIN_ID}/api/slack-inbound`;
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ companyId: cfg.companyId, botKey, surface, message } satisfies ScopedChatRequest),
  });
  if (!response.ok) {
    throw new Error(`Paperclip scoped Slack bridge returned HTTP ${response.status}`);
  }
}

async function handleScopedApiRequest(
  ctx: PluginContext,
  input: PluginApiRequestInput,
): Promise<PluginApiResponse> {
  if (input.routeKey !== API_ROUTE_KEYS.slackInbound) {
    return { status: 404, body: { error: "Unknown plugin API route" } };
  }

  const request = parseScopedChatRequest(input.body);
  if (!request) return { status: 400, body: { error: "Invalid Slack callback payload" } };
  if (request.companyId !== input.companyId || request.companyId !== boundCompanyId) {
    return { status: 403, body: { error: "Company scope mismatch" } };
  }

  const botKey = request.botKey ?? "primary";
  const runtime = botKey === "primary" ? null : additionalBotRuntimes.get(botKey);
  if (botKey !== "primary" && !runtime) {
    return { status: 404, body: { error: "Unknown Slack bot key" } };
  }
  const primary = botKey === "primary" ? ensureCoreModules(ctx) : null;
  const chat = runtime?.chat ?? primary!.chat;
  const askHuman = primary?.askHuman;
  const cfg = runtime?.config ?? getLiveConfig();
  const { message, surface } = request;
  if (!(await checkAccess(ctx, message.user, surface, cfg, botKey))) return { status: 204 };
  if (!eventDeduper.shouldProcess(`${botKey}:${surface}:${message.channel}:${message.ts}`)) return { status: 204 };

  if (surface === "mention") {
    await chat.handleMention(message);
  } else {
    if (askHuman && (await askHuman.tryHandleAnswer(message))) return { status: 204 };
    await chat.handleMessage(message);
  }
  return { status: 204 };
}

// --- Config apply pump ---------------------------------------------------
//
// Bug: Node's AsyncLocalStorage context propagates into anything created
// inside `als.run(...)` — including sockets — and every later callback from
// that socket keeps running in the captured store. The plugin SDK wraps
// host->worker calls that carry a `paperclipInvocation` (e.g. `configChanged`)
// in `invocationContextStorage.run(...)` and echoes the store's invocation id
// on every worker->host call the plugin makes afterwards. If the Slack Bolt
// gateway were constructed synchronously inside `onConfigChanged`, it would
// be built inside that invocation's ALS store, and every subsequent Slack
// event (chat message, mention, action, command) would echo the id of a
// `configChanged` invocation the host finished long ago — the host looks it
// up, finds nothing, and denies the call with "unknown invocation scope".
//
// The fix: never call `applyConfig` (and therefore never construct the
// gateway) from inside `onConfigChanged` itself. Instead, `onConfigChanged`
// only enqueues the merged config and returns a promise that resolves once
// that job has been applied. A single pump loop, started once from `setup()`
// (i.e. with a clean/no ALS store), drains the queue. Because the pump's
// `for(;;)` loop and its `await waitForWork()` continuation were both set up
// outside any `als.run(...)` call, they resume in a clean store even though
// `signalPump()` is invoked synchronously from inside the `configChanged`
// invocation's store — a `new Promise(resolve => { wakePump = resolve })`
// does not adopt the calling context of whoever eventually calls `resolve()`,
// it keeps the context active at its own creation site. Any gateway created
// from within the pump's loop body therefore has no ALS store at all, exactly
// like `setup()` itself.
interface PendingApply {
  cfg: SlackSocketConfig;
  resolvedTokens?: ResolvedSlackTokenSet;
  secretResolutionError?: unknown;
  scopedBridge?: boolean;
  done: () => void;
}
interface ResolvedSlackTokens {
  botToken: string;
  appToken: string;
}
interface ResolvedSlackTokenSet {
  primary: ResolvedSlackTokens;
  additional: Record<string, ResolvedSlackTokens>;
}
let applyQueue: PendingApply[] = [];
let wakePump: (() => void) | null = null;
let pumpSignalled = false;
let pumpStarted = false;
// True for the whole duration of an `applyConfig` call, not just while a job
// sits in `applyQueue` — the pump `shift()`s a job off the queue before
// awaiting `applyConfig`, so `applyQueue.length` alone reads as empty for the
// entire apply (e.g. a new gateway's `start()` handshake). The socket
// watchdog below checks this flag too, so a tick landing mid-apply never
// mistakes a gateway that is legitimately still connecting for a dead one.
let applyInFlight = false;

function signalPump(): void {
  pumpSignalled = true;
  const wake = wakePump;
  wakePump = null;
  if (wake) wake();
}

async function waitForWork(): Promise<void> {
  if (pumpSignalled) {
    pumpSignalled = false;
    return;
  }
  await new Promise<void>((resolve) => {
    wakePump = resolve;
  });
  pumpSignalled = false;
}

/**
 * Starts the single, process-lifetime pump that drains `applyQueue` by
 * calling `applyConfig`. Must be called exactly once, from `setup()`, so the
 * pump's loop — and therefore every gateway it creates — runs with a clean
 * ALS store rather than whatever invocation happened to be active on the
 * host call that queued a job. Guarded by `pumpStarted` for idempotency.
 */
function startConfigPump(ctx: PluginContext, makeGateway: GatewayFactory): void {
  if (pumpStarted) return;
  pumpStarted = true;
  void (async () => {
    for (;;) {
      await waitForWork();
      while (applyQueue.length) {
        const job = applyQueue.shift()!;
        applyInFlight = true;
        try {
          await applyConfig(ctx, job.cfg, makeGateway, {
            resolvedTokens: job.resolvedTokens,
            secretResolutionError: job.secretResolutionError,
            scopedBridge: job.scopedBridge,
          });
        } catch (err) {
          ctx.logger.error("Slack config apply failed", { err: errString(err) });
          health = { status: "degraded", message: `Slack Socket configuration failed: ${errString(err)}` };
        } finally {
          applyInFlight = false;
          job.done();
        }
      }
    }
  })();
}

// --- Socket Mode watchdog -------------------------------------------------
//
// Bolt's socket-mode client stops reconnecting on unrecoverable failures
// (invalid/revoked/rotated token, exhausted network retries), and a
// `gateway.start()` that threw leaves `currentGateway` holding a DEAD,
// NON-NULL gateway — it is assigned just before the try/catch in
// `applyConfig`. Nothing else in this process ever retries, so without this
// poll the plugin sits degraded until an operator re-saves config by hand.
// The liveness check therefore probes rather than testing for a missing
// gateway, and it does not rest on `isConnected()` alone — that flag is fed
// by listeners attached to Bolt's private receiver internals with optional
// chaining, so it would silently never flip if Bolt's shape changed.
//
// RECOVERY GOES THROUGH THE PUMP AND NEVER CALLS `applyConfig` DIRECTLY.
// See the "Config apply pump" comment above for the full reasoning: a timer
// callback that constructed the gateway itself would build it inside
// whatever AsyncLocalStorage store happened to be active, after which every
// Slack event would echo the id of an invocation the host finished long ago
// and be denied with "unknown invocation scope". Enqueueing keeps gateway
// construction inside the pump's clean store. Re-applying also re-resolves
// both secret refs, so a rotated token is picked up without an operator save.
//
// Two more failure modes this section guards against, both found by review
// and reproduced empirically:
//  - A `probe()` that never settles must not wedge `recoveryInFlight` shut
//    forever. `gateway.probe()` is a plain HTTP call, and a WebClient with no
//    configured timeout plus Slack's default ~10-retries-over-~30-minutes
//    policy can leave it pending far longer than this watchdog's 60s tick
//    interval — precisely in the revoked-token case this feature exists to
//    fix, since that's when `isConnected()` is still true and the `&&` below
//    actually calls `probe()`. `probeWithTimeout` bounds every probe, for
//    every `SlackGateway` implementation, not just Bolt's.
//  - `liveConfig` must be re-read immediately before enqueueing a recovery
//    job, not reused from a value captured before the probe was awaited: an
//    operator's own config save can land and fully complete while a tick is
//    mid-probe (it isn't blocked by `recoveryInFlight`, which only guards
//    this function's own re-entrancy), and enqueueing a stale capture would
//    silently revert that completed save — including a narrowed
//    `allowedSlackUserIds`/`agentPostChannelIds`/`agentPostMessageEnabled`.
const SOCKET_WATCHDOG_INTERVAL_MS = 60_000;
const RECOVERY_BACKOFF_MS: readonly number[] = [60_000, 120_000, 240_000, 480_000, 900_000];
// Well under the 60s tick interval, so a hung probe is bounded to a small
// fraction of one tick rather than swallowing several.
const PROBE_TIMEOUT_MS = 10_000;
// A single not-alive observation is not proof of death: `isConnected()` is
// false during Bolt's own routine reconnects (onHealth words that state
// "Bolt is reconnecting"), and one slow `auth.test` fails the 10s probe
// while the socket is fine. Tearing down on the first observation would
// rebuild a healthy gateway — dropping its in-flight events — every time a
// tick landed inside such a window, and a successful rebuild resets the
// backoff, so a Slack latency incident would repeat that teardown every
// single tick. Requiring consecutive observations one full tick apart means
// only a condition that persists for a minute triggers recovery; a genuinely
// dead socket just waits one extra tick.
const NOT_ALIVE_TICKS_BEFORE_RECOVERY = 2;

let watchdogStarted = false;
let recoveryInFlight = false;
let recoveryAttempts = 0;
let recoveryNotBefore = 0;
// Consecutive watchdog ticks that observed a not-alive gateway. Reset only
// by the watchdog's own observations (an alive tick, or a recovery that
// succeeded) — never by applyConfig, whose job is the gateway, not the
// watchdog's memory of what it has seen.
let notAliveStreak = 0;

/** 1m -> 2m -> 4m -> 8m -> 15m, then flat at the 15m cap. */
function backoffFor(attempt: number): number {
  return RECOVERY_BACKOFF_MS[Math.min(Math.max(attempt, 1), RECOVERY_BACKOFF_MS.length) - 1];
}

/**
 * Bounds `gateway.probe()` to `timeoutMs` so a hung round-trip can never
 * wedge the watchdog: `await`ing an unbounded `probe()` would suspend
 * `socketWatchdogTick` indefinitely, and since control never returns to it,
 * the `finally { recoveryInFlight = false }` below would never run either —
 * this function is what keeps that `await` from ever going unbounded.
 * Treats a timeout, and a rejection, the same as `probe()` resolving
 * `false`: "not alive", which is exactly the signal that should trigger
 * recovery rather than be swallowed. Lives here — bounding every
 * `SlackGateway` implementation from the call site — rather than inside
 * `BoltGateway.probe()` itself, which only Bolt would benefit from.
 */
function probeWithTimeout(gateway: SlackGateway, timeoutMs: number): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      resolve(false);
    }, timeoutMs);
    // Bookkeeping timer only; never let it hold the process (or a test run)
    // open by itself.
    timer.unref();
    gateway.probe().then(
      (result) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(result);
      },
      () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(false);
      },
    );
  });
}

/**
 * One watchdog poll. Exported as a test seam (same precedent as
 * `startRuntime`) so tests can drive ticks deterministically with an
 * injected clock instead of waiting out a 60s interval.
 */
export async function socketWatchdogTick(ctx: PluginContext, now: number = Date.now()): Promise<void> {
  // Nothing to recover to before a structurally-valid config has ever been
  // pushed (liveConfig for an apply that succeeded at least once,
  // lastAttemptedConfig for a first apply that failed on a transient step —
  // see its declaration); never re-enter; never race the pump — a queued OR
  // in-flight apply is either about to rebuild the gateway or is already
  // mid-handshake, and in both cases this tick has nothing useful to add;
  // and honor the backoff deadline.
  if (
    (!liveConfig && !lastAttemptedConfig) ||
    recoveryInFlight ||
    applyQueue.length > 0 ||
    applyInFlight ||
    now < recoveryNotBefore
  ) {
    return;
  }

  recoveryInFlight = true;
  try {
    const gateways = [currentGateway, ...[...additionalBotRuntimes.values()].map((runtime) => runtime.gateway)];
    const aliveChecks = await Promise.all(
      gateways.map((gateway) =>
        gateway !== null && gateway.isConnected() ? probeWithTimeout(gateway, PROBE_TIMEOUT_MS) : false,
      ),
    );
    const alive = gateways.length > 0 && aliveChecks.every(Boolean);
    if (alive) {
      notAliveStreak = 0;
      recoveryAttempts = 0;
      recoveryNotBefore = 0;
      return;
    }

    // First not-alive observation: note it and stand down until the next
    // tick — see NOT_ALIVE_TICKS_BEFORE_RECOVERY above for why one
    // observation must never trigger a teardown.
    notAliveStreak += 1;
    if (notAliveStreak < NOT_ALIVE_TICKS_BEFORE_RECOVERY) {
      ctx.logger.info("Slack Socket Mode looks dead; confirming on the next tick before recovering", {
        observation: notAliveStreak,
      });
      return;
    }

    // Re-checked here, after the probe was awaited: if an operator save
    // landed while we were probing, another apply may now be queued or
    // in-flight that will settle things on its own — bail before counting an
    // attempt the operator's save is already making moot.
    if ((!liveConfig && !lastAttemptedConfig) || applyQueue.length > 0 || applyInFlight) return;

    const attempt = (recoveryAttempts += 1);
    ctx.logger.warn("Slack Socket Mode looks dead; re-applying the live config to recover", { attempt });
    await ctx.metrics.write("slack.socket.recovery.attempted", 1, { attempt: String(attempt) }).catch(() => {});

    // The config is captured HERE, synchronously with the enqueue — never
    // before an `await`. The metrics write above suspends this tick exactly
    // like the probe does, and an operator save that lands and completes
    // inside either await would be silently reverted by enqueueing a config
    // captured before it (including access-narrowing fields like
    // allowedSlackUserIds/agentPostChannelIds/agentPostMessageEnabled).
    // Nothing may suspend between this re-check, the capture, and the push.
    const cfg = liveConfig ?? lastAttemptedConfig;
    if (!cfg || applyQueue.length > 0 || applyInFlight) return;
    await new Promise<void>((resolve) => {
      applyQueue.push({ cfg, scopedBridge: true, done: resolve });
      signalPump();
    });

    if (health.status === "ok") {
      notAliveStreak = 0;
      recoveryAttempts = 0;
      recoveryNotBefore = 0;
      ctx.logger.info("Slack Socket Mode recovered", { attempt });
      await ctx.metrics.write("slack.socket.recovery.succeeded", 1, { attempt: String(attempt) }).catch(() => {});
    } else {
      recoveryNotBefore = now + backoffFor(attempt);
      await ctx.metrics.write("slack.socket.recovery.failed", 1, { attempt: String(attempt) }).catch(() => {});
    }
  } finally {
    recoveryInFlight = false;
  }
}

/**
 * Starts the single, process-lifetime Socket Mode watchdog. Must be called
 * exactly once, from `setup()` — the same clean-ALS-store reasoning as
 * `startConfigPump`. Guarded by `watchdogStarted` for idempotency, and the
 * interval is unref'd so a 60s poll can never hold the process (or a test
 * run) open.
 */
export function startSocketWatchdog(ctx: PluginContext): void {
  if (watchdogStarted) return;
  watchdogStarted = true;
  const timer = setInterval(() => {
    void socketWatchdogTick(ctx).catch((err) => {
      ctx.logger.warn("Slack Socket Mode watchdog tick failed", { err: errString(err) });
    });
  }, SOCKET_WATCHDOG_INTERVAL_MS);
  timer.unref();
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
  const askHuman = createAskHuman({ ctx, gateway: gatewayProxy, getConfig });
  const commands = createCommands({ ctx, gateway: gatewayProxy, getConfig });
  // Both tools register here, from setup()'s clean context, against the
  // gateway proxy — the real gateway doesn't exist until a config arrives.
  // Registration therefore cannot be gated on config: slack_post_message
  // enforces its switches per call instead (see checkPostTarget).
  const postMessage = createPostMessage({ ctx, gateway: gatewayProxy, getConfig });
  askHuman.registerTool();
  postMessage.registerTool();

  coreModules = { chat, askHuman, commands, postMessage, gatewayProxy };
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

function additionalBotConfigError(bots: AdditionalSlackBotConfig[]): string | null {
  const keys = new Set<string>();
  for (const bot of bots) {
    const key = bot.key.trim();
    if (!key) return "additionalBots contains an empty key";
    if (key !== bot.key || !/^[a-z0-9][a-z0-9_-]*$/.test(key)) {
      return `additionalBots key "${bot.key}" must use lowercase letters, numbers, hyphens, or underscores`;
    }
    if (key === "primary") return 'additionalBots key "primary" is reserved';
    if (keys.has(key)) return `additionalBots contains duplicate key "${key}"`;
    keys.add(key);
    if (!bot.slackBotTokenRef || !bot.slackAppTokenRef || !bot.agentId) {
      return `additionalBots entry "${key}" is missing a token reference or agentId`;
    }
  }
  return null;
}

function effectiveAdditionalBotConfig(
  cfg: SlackSocketConfig,
  bot: AdditionalSlackBotConfig,
): SlackSocketConfig {
  return {
    ...cfg,
    slackBotTokenRef: bot.slackBotTokenRef,
    slackAppTokenRef: bot.slackAppTokenRef,
    defaultAgentId: bot.agentId,
    allowedSlackUserIds: bot.allowedSlackUserIds ?? cfg.allowedSlackUserIds,
    additionalBots: [],
  };
}

async function resolveAllSlackTokens(ctx: PluginContext, cfg: SlackSocketConfig): Promise<ResolvedSlackTokenSet> {
  const primary = {
    botToken: await ctx.secrets.resolve(cfg.slackBotTokenRef, { companyId: cfg.companyId }),
    appToken: await ctx.secrets.resolve(cfg.slackAppTokenRef, { companyId: cfg.companyId }),
  };
  const additional: Record<string, ResolvedSlackTokens> = {};
  for (const bot of cfg.additionalBots) {
    additional[bot.key] = {
      botToken: await ctx.secrets.resolve(bot.slackBotTokenRef, { companyId: cfg.companyId }),
      appToken: await ctx.secrets.resolve(bot.slackAppTokenRef, { companyId: cfg.companyId }),
    };
  }
  return { primary, additional };
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
 * `currentGateway` are left completely untouched. One consequence worth
 * naming: this also means a *revoked* posting permission (e.g. narrowing
 * `agentPostChannelIds` or turning `agentPostMessageEnabled` off) does not
 * take effect if the save fails — for example during a brief secrets-backend
 * outage — the previous, more permissive `liveConfig` stays live until a
 * save succeeds.
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
  prepared: {
    resolvedTokens?: ResolvedSlackTokenSet;
    secretResolutionError?: unknown;
    scopedBridge?: boolean;
  } = {},
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

  const additionalConfigError = additionalBotConfigError(cfg.additionalBots);
  if (additionalConfigError) {
    health = liveConfig
      ? {
          status: "degraded",
          message: `New Slack Socket configuration rejected (${additionalConfigError}); the previous configuration is still active`,
        }
      : { status: "degraded", message: `Slack Socket plugin not configured: ${additionalConfigError}` };
    ctx.logger.warn("Slack Socket plugin additional bot configuration rejected", { error: additionalConfigError });
    if (didClaim) boundCompanyId = null;
    return health;
  }

  // Structurally valid for the bound company: remember it so the watchdog
  // can retry a first-ever apply that fails on a transient step below (see
  // lastAttemptedConfig's declaration). Configs that fail the checks above
  // are deliberately never remembered.
  lastAttemptedConfig = cfg;

  let resolvedTokens: ResolvedSlackTokenSet;
  try {
    if (prepared.secretResolutionError) throw prepared.secretResolutionError;
    if (prepared.resolvedTokens) {
      resolvedTokens = prepared.resolvedTokens;
    } else {
      resolvedTokens = await resolveAllSlackTokens(ctx, cfg);
    }
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
  await Promise.all([...additionalBotRuntimes.values()].map((runtime) => runtime.gateway.stop().catch(() => {})));
  additionalBotRuntimes = new Map();
  liveConfig = cfg;

  const gateway = makeGateway(resolvedTokens.primary);

  gateway.onMention(async (msg) => {
    if (prepared.scopedBridge) {
      await forwardChatThroughScopedRoute(cfg, "primary", "mention", msg);
      return;
    }
    if (!(await checkAccess(ctx, msg.user, "mention"))) return;
    if (!eventDeduper.shouldProcess(`mention:${msg.channel}:${msg.ts}`)) return;
    await chat.handleMention(msg);
  });
  gateway.onMessage(async (msg) => {
    if (prepared.scopedBridge) {
      await forwardChatThroughScopedRoute(cfg, "primary", "message", msg);
      return;
    }
    if (!(await checkAccess(ctx, msg.user, "message"))) return;
    if (!eventDeduper.shouldProcess(`message:${msg.channel}:${msg.ts}`)) return;
    if (await askHuman.tryHandleAnswer(msg)) return;
    await chat.handleMessage(msg);
  });
  gateway.onReaction(async (reaction) => {
    if (!(await checkAccess(ctx, reaction.user, "reaction"))) return;
    await askHuman.handleReaction(reaction);
  });
  gateway.onAction(/^approval_(approve|reject)$/, async (action) => {
    if (!(await checkAccess(ctx, action.user, "action"))) return;
    await approvals.handleAction(action);
  });
  gateway.onCommand(SLASH_COMMAND, async (cmd) => {
    if (!(await checkAccess(ctx, cmd.user, "command"))) return;
    await commands.handleCommand(cmd);
  });

  currentGateway = gateway;
  try {
    await gateway.start();
    for (const bot of cfg.additionalBots) {
      const botCfg = effectiveAdditionalBotConfig(cfg, bot);
      const botGateway = makeGateway(resolvedTokens.additional[bot.key]);
      const getConfig = async (): Promise<SlackSocketConfig> => botCfg;
      const botChat = createChat({
        ctx,
        gateway: botGateway,
        getConfig,
        sessionKeyPrefix: `bot:${bot.key}:`,
      });
      const runtime: AdditionalBotRuntime = {
        key: bot.key,
        config: botCfg,
        gateway: botGateway,
        chat: botChat,
      };
      additionalBotRuntimes.set(bot.key, runtime);

      botGateway.onMention(async (msg) => {
        if (prepared.scopedBridge) {
          await forwardChatThroughScopedRoute(botCfg, bot.key, "mention", msg);
          return;
        }
        if (!(await checkAccess(ctx, msg.user, "mention", botCfg, bot.key))) return;
        if (!eventDeduper.shouldProcess(`${bot.key}:mention:${msg.channel}:${msg.ts}`)) return;
        await botChat.handleMention(msg);
      });
      botGateway.onMessage(async (msg) => {
        if (prepared.scopedBridge) {
          await forwardChatThroughScopedRoute(botCfg, bot.key, "message", msg);
          return;
        }
        if (!(await checkAccess(ctx, msg.user, "message", botCfg, bot.key))) return;
        if (!eventDeduper.shouldProcess(`${bot.key}:message:${msg.channel}:${msg.ts}`)) return;
        await botChat.handleMessage(msg);
      });
      await botGateway.start();
    }
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
  // A successful apply proves the bind is good right now, so any watchdog
  // backoff state from a previous failed recovery attempt is stale. Reset it
  // here rather than waiting for the next tick to notice: ticks are gated by
  // `recoveryNotBefore`, which escalates up to 15 minutes, so without this an
  // operator who fixes a revoked token with a normal config save would still
  // see onHealth report "recovery attempt N" for up to 15 more minutes even
  // though the socket is already back up.
  recoveryAttempts = 0;
  recoveryNotBefore = 0;
  health = { status: "ok" };
  ctx.logger.info("Slack Socket Mode connected", { botCount: 1 + cfg.additionalBots.length });
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
    startConfigPump(ctx, (opts) => new BoltGateway({ ...opts, logger: ctx.logger }));
    startSocketWatchdog(ctx);
  },

  // Never calls `applyConfig` (and therefore never constructs the gateway)
  // directly — see the "Config apply pump" comment above `startConfigPump`
  // for why. This just enqueues the merged config for the pump and waits for
  // that specific job to finish, so the host's call completes only once the
  // config has actually been applied.
  async onConfigChanged(config) {
    const cfg = mergeConfig(config);
    let resolvedTokens: ResolvedSlackTokenSet | undefined;
    let secretResolutionError: unknown;

    // Paperclip authorizes secret access only for the lifetime of this
    // company-scoped host invocation. Resolve the credentials here, while
    // that scope is active, but keep gateway construction in the clean-ALS
    // pump below so future Slack callbacks do not inherit a stale invocation.
    if (REQUIRED_FIELDS.every((field) => cfg[field])) {
      try {
        resolvedTokens = await resolveAllSlackTokens(lastCtx!, cfg);
      } catch (err) {
        secretResolutionError = err;
      }
    }

    await new Promise<void>((resolve) => {
      applyQueue.push({ cfg, resolvedTokens, secretResolutionError, scopedBridge: true, done: resolve });
      signalPump();
    });
  },

  async onApiRequest(input) {
    return handleScopedApiRequest(lastCtx!, input);
  },

  async onShutdown() {
    await currentGateway?.stop().catch(() => {});
    await Promise.all([...additionalBotRuntimes.values()].map((runtime) => runtime.gateway.stop().catch(() => {})));
  },

  async onHealth() {
    if (tenantConflict) return { status: "degraded", message: tenantConflict };
    if (!liveConfig) return { status: "degraded", message: "Waiting for configuration" };
    // Reported ahead of `health` on purpose: while the watchdog is backing
    // off, "recovery attempt N" is what an operator needs to see — that the
    // socket is dead AND that it is being retried — not just the apply error
    // left behind by the most recent failed attempt.
    if (recoveryAttempts > 0) {
      return {
        status: "degraded",
        message: `Slack Socket Mode disconnected; recovery attempt ${recoveryAttempts}`,
      };
    }
    if (health.status !== "ok") return health;
    if (currentGateway && !currentGateway.isConnected()) {
      return { status: "degraded", message: "Slack Socket Mode disconnected; Bolt is reconnecting" };
    }
    const disconnectedBot = [...additionalBotRuntimes.values()].find((runtime) => !runtime.gateway.isConnected());
    if (disconnectedBot) {
      return {
        status: "degraded",
        message: `Slack bot "${disconnectedBot.key}" disconnected; Bolt is reconnecting`,
      };
    }
    return { status: "ok" };
  },

  async onValidateConfig(config) {
    const cfg = mergeConfig(config);
    const errors: string[] = [];
    for (const field of [...REQUIRED_FIELDS, "defaultChannelId"] as const) {
      if (!cfg[field]) errors.push(`${field} is required`);
    }
    const additionalError = additionalBotConfigError(cfg.additionalBots);
    if (additionalError) errors.push(additionalError);
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
    for (const bot of cfg.additionalBots) {
      try {
        const botToken = await lastCtx.secrets.resolve(bot.slackBotTokenRef, { companyId: cfg.companyId });
        const auth = await new WebClient(botToken).auth.test();
        if (!auth.ok) errors.push(`Bot token check failed for additional bot "${bot.key}"`);
      } catch (err) {
        errors.push(`Bot token check failed for additional bot "${bot.key}": ${describeHostError(err)}`);
      }
      try {
        const appToken = await lastCtx.secrets.resolve(bot.slackAppTokenRef, { companyId: cfg.companyId });
        const conn = await new WebClient(appToken).apps.connections.open();
        if (!conn.ok) errors.push(`App token check failed for additional bot "${bot.key}"`);
      } catch (err) {
        errors.push(`App token check failed for additional bot "${bot.key}": ${describeHostError(err)}`);
      }
    }
    return { ok: errors.length === 0, errors };
  },
});

export default plugin;
runWorker(plugin, import.meta.url);
