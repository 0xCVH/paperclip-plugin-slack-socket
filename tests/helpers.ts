import { vi } from "vitest";
import type { PluginContext } from "@paperclipai/plugin-sdk";
import type {
  InboundAction,
  InboundCommand,
  InboundMessage,
  InboundReaction,
  OutboundMessage,
  SlackGateway,
  SlackSocketConfig,
} from "../src/types.js";
import { DEFAULT_CONFIG } from "../src/constants.js";

export const TEST_CONFIG: SlackSocketConfig = {
  ...DEFAULT_CONFIG,
  slackBotTokenRef: "ref-bot",
  slackAppTokenRef: "ref-app",
  companyId: "co-1",
  defaultAgentId: "agent-1",
  defaultChannelId: "C-DEFAULT",
  paperclipBaseUrl: "https://pc.example",
};

export interface MockCtxBundle {
  ctx: PluginContext;
  stateStore: Map<string, unknown>;
  emitEvent: (name: string, event: unknown) => Promise<void>;
}

export function makeCtx(configOverrides: Partial<SlackSocketConfig> = {}): MockCtxBundle {
  const stateStore = new Map<string, unknown>();
  const eventHandlers = new Map<string, Array<(event: unknown) => Promise<void>>>();

  const ctx = {
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    metrics: { write: vi.fn().mockResolvedValue(undefined) },
    activity: { log: vi.fn().mockResolvedValue(undefined) },
    state: {
      get: vi.fn(async (key: { stateKey: string }) => stateStore.get(key.stateKey) ?? null),
      set: vi.fn(async (key: { stateKey: string }, value: unknown) => {
        stateStore.set(key.stateKey, value);
      }),
      delete: vi.fn(async (key: { stateKey: string }) => {
        stateStore.delete(key.stateKey);
      }),
    },
    events: {
      // Mirrors the SDK's two overloads: `on(name, handler)` and
      // `on(name, filter, handler)`. Tests assert on the filter argument via
      // `(ctx.events.on as any).mock.calls`, so this mock records calls with
      // whatever arity was actually used rather than normalizing it away.
      on: vi.fn(
        (
          name: string,
          filterOrHandler: Record<string, unknown> | ((event: unknown) => Promise<void>),
          maybeHandler?: (event: unknown) => Promise<void>,
        ) => {
          const handler = typeof filterOrHandler === "function" ? filterOrHandler : maybeHandler!;
          const list = eventHandlers.get(name) ?? [];
          list.push(handler);
          eventHandlers.set(name, list);
        },
      ),
    },
    agents: {
      sessions: {
        create: vi.fn().mockResolvedValue({
          sessionId: "sess-1",
          agentId: "agent-1",
          companyId: "co-1",
          status: "active",
          createdAt: "2026-08-01T00:00:00.000Z",
        }),
        sendMessage: vi.fn(
          async (_sessionId: string, _companyId: string, opts: { onEvent?: (e: unknown) => void }) => {
            opts.onEvent?.({
              sessionId: "sess-1", runId: "run-1", seq: 1,
              eventType: "chunk", stream: "stdout", message: "Hello", payload: null,
            });
            opts.onEvent?.({
              sessionId: "sess-1", runId: "run-1", seq: 2,
              eventType: "done", stream: null, message: "Hello there!", payload: null,
            });
            return { runId: "run-1" };
          },
        ),
        close: vi.fn().mockResolvedValue(undefined),
        list: vi.fn().mockResolvedValue([]),
      },
    },
    issues: {
      create: vi.fn().mockResolvedValue({ id: "issue-1", title: "Test issue" }),
      createComment: vi.fn().mockResolvedValue({ id: "comment-1" }),
      requestWakeup: vi.fn().mockResolvedValue({ requested: true }),
    },
    http: {
      fetch: vi.fn().mockResolvedValue({ status: 200, json: async () => ({}) }),
    },
    tools: { register: vi.fn() },
    jobs: { register: vi.fn() },
    secrets: { resolve: vi.fn(async (ref: string) => `secret-${ref}`) },
    // Deliberately no `config.get` mock: this plugin is "proactive" and
    // never calls it (see config.ts) — outside a host-issued invocation
    // there's no way for `config.get()` to resolve company scope. Omitted
    // rather than stubbed so a regression that starts calling it fails
    // loudly instead of silently succeeding against a mock.
  };

  return {
    ctx: ctx as unknown as PluginContext,
    stateStore,
    emitEvent: async (name, event) => {
      for (const handler of eventHandlers.get(name) ?? []) await handler(event);
    },
  };
}

export class FakeGateway implements SlackGateway {
  posts: Array<OutboundMessage & { ts: string }> = [];
  updates: Array<{ channel: string; ts: string; text: string; blocks?: unknown[] }> = [];
  ephemerals: Array<{ channel: string; user: string; text: string }> = [];
  dmOpens: string[] = [];
  started = false;

  private botId: string | undefined = "UBOT";
  private tsCounter = 0;
  private messageHandlers: Array<(msg: InboundMessage) => Promise<void>> = [];
  private mentionHandlers: Array<(msg: InboundMessage) => Promise<void>> = [];
  private reactionHandlers: Array<(r: InboundReaction) => Promise<void>> = [];
  private actionHandlers: Array<{ pattern: RegExp; handler: (a: InboundAction) => Promise<void> }> = [];
  private commandHandlers: Array<{ command: string; handler: (c: InboundCommand) => Promise<void> }> = [];

  setBotUserId(id: string | undefined): void { this.botId = id; }

  async start(): Promise<void> { this.started = true; }
  async stop(): Promise<void> { this.started = false; }
  isConnected(): boolean { return this.started; }
  botUserId(): string | undefined { return this.botId; }

  async postMessage(msg: OutboundMessage): Promise<{ channel: string; ts: string }> {
    const ts = `1700000000.${String(++this.tsCounter).padStart(6, "0")}`;
    this.posts.push({ ...msg, ts });
    return { channel: msg.channel, ts };
  }

  async updateMessage(msg: { channel: string; ts: string; text: string; blocks?: unknown[] }): Promise<void> {
    this.updates.push(msg);
  }

  async postEphemeral(msg: { channel: string; user: string; text: string }): Promise<void> {
    this.ephemerals.push(msg);
  }

  async openDm(userId: string): Promise<string> {
    this.dmOpens.push(userId);
    return `D-${userId}`;
  }

  async getUserDisplayName(userId: string): Promise<string> {
    return `name-${userId}`;
  }

  onMessage(handler: (msg: InboundMessage) => Promise<void>): void { this.messageHandlers.push(handler); }
  onMention(handler: (msg: InboundMessage) => Promise<void>): void { this.mentionHandlers.push(handler); }
  onReaction(handler: (r: InboundReaction) => Promise<void>): void { this.reactionHandlers.push(handler); }
  onAction(pattern: RegExp, handler: (a: InboundAction) => Promise<void>): void {
    this.actionHandlers.push({ pattern, handler });
  }
  onCommand(command: string, handler: (c: InboundCommand) => Promise<void>): void {
    this.commandHandlers.push({ command, handler });
  }

  async emitMessage(msg: InboundMessage): Promise<void> {
    for (const h of this.messageHandlers) await h(msg);
  }
  async emitMention(msg: InboundMessage): Promise<void> {
    for (const h of this.mentionHandlers) await h(msg);
  }
  async emitReaction(reaction: InboundReaction): Promise<void> {
    for (const h of this.reactionHandlers) await h(reaction);
  }
  async emitAction(action: InboundAction): Promise<void> {
    for (const { pattern, handler } of this.actionHandlers) {
      if (pattern.test(action.actionId)) await handler(action);
    }
  }
  async emitCommand(cmd: InboundCommand): Promise<void> {
    for (const { command, handler } of this.commandHandlers) {
      if (command === cmd.command) await handler(cmd);
    }
  }
}
