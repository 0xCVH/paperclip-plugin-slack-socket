# Slack Socket Mode Plugin Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build `paperclip-plugin-slack-socket` — a Paperclip plugin connecting Slack via Socket Mode (outbound WebSocket, no public URL): agent chat in DMs/mentions, configurable notifications, interactive approvals, an `ask_human` agent tool, and a `/paperclip` slash command.

**Architecture:** A Paperclip plugin worker (`definePlugin` + `runWorker`) holds one Bolt `App` in Socket Mode. A thin `SlackGateway` interface wraps Bolt so every feature module (chat, notifications, approvals, ask-human, commands, cleanup) is pure logic testable against a `FakeGateway` and a mock `PluginContext`. The worker composes the modules and owns lifecycle/health.

**Tech Stack:** TypeScript (ESM, NodeNext), `@slack/bolt` ^4 + `@slack/web-api` ^7, `@paperclipai/plugin-sdk` (peer dep), vitest, plain `tsc` build (same as the reference plugin `mvanhorn/paperclip-plugin-slack`).

**Spec:** `docs/superpowers/specs/2026-08-01-slack-socket-mode-plugin-design.md`

## Global Constraints

- Package name `paperclip-plugin-slack-socket`; plugin id `cvh.slack-socket`; version `0.1.0`.
- ESM only (`"type": "module"`); all relative imports use `.js` extensions (NodeNext).
- Manifest declares **zero webhooks**. Capabilities exactly: `companies.read`, `issues.read`, `issues.create`, `issue.comments.create`, `issues.wakeup`, `agents.read`, `agent.sessions.create`, `agent.sessions.send`, `agent.sessions.close`, `agent.tools.register`, `approvals.read`, `approvals.respond`, `events.subscribe`, `plugin.state.read`, `plugin.state.write`, `secrets.read-ref`, `instance.settings.register`, `activity.log.write`, `metrics.write`, `jobs.schedule`.
- Secrets only via Paperclip secret refs (`ctx.secrets.resolve`); never log or echo tokens.
- All Slack input is untrusted: validate tool params; privileged actions only via button interactions with the acting Slack user recorded.
- Node built-ins only plus declared deps; SDK is a **peerDependency** (also a devDependency for tests), Bolt/web-api are runtime **dependencies**.
- Every plugin state access uses scope `{ scopeKind: "instance", namespace: "slack-socket", stateKey }` via the `stateScope` helper.
- Commit after every task with the message given in the task's final step; append `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>` to every commit message body.

---

### Task 1: Package scaffold, constants, types, config loader

**Files:**
- Create: `package.json`, `tsconfig.json`, `.gitignore`
- Create: `src/constants.ts`, `src/types.ts`, `src/config.ts`, `src/index.ts`

**Interfaces:**
- Consumes: nothing (first task).
- Produces: `SlackSocketConfig`, `SessionEntry`, `PendingQuestion`, `SlackGateway` (+ inbound/outbound message types), `PLUGIN_ID`, `PLUGIN_VERSION`, `STATE_KEYS`, `stateScope(stateKey)`, `ACTION_IDS`, `JOB_KEYS`, `TOOL_NAMES`, `SLASH_COMMAND`, `ASK_HUMAN_TOOL_DECLARATION`, `DEFAULT_CONFIG`, `loadConfig(ctx): Promise<SlackSocketConfig>`. Every later task imports from these files.

- [ ] **Step 1: Write `package.json`**

```json
{
  "name": "paperclip-plugin-slack-socket",
  "version": "0.1.0",
  "type": "module",
  "description": "Slack Socket Mode plugin for Paperclip: agent chat, notifications, approvals, ask-human tool. No public URL required.",
  "main": "./dist/index.js",
  "scripts": {
    "build": "tsc",
    "typecheck": "tsc --noEmit",
    "test": "vitest run",
    "prepublishOnly": "npm run build"
  },
  "dependencies": {
    "@slack/bolt": "^4.2.0",
    "@slack/web-api": "^7.8.0"
  },
  "peerDependencies": {
    "@paperclipai/plugin-sdk": "*"
  },
  "devDependencies": {
    "@paperclipai/plugin-sdk": "^2026.618.0",
    "@types/node": "^25.5.2",
    "typescript": "^5.7.0",
    "vitest": "^3.2.6"
  },
  "files": ["dist/"],
  "paperclipPlugin": {
    "manifest": "./dist/manifest.js",
    "worker": "./dist/worker.js"
  },
  "license": "MIT"
}
```

- [ ] **Step 2: Write `tsconfig.json` and `.gitignore`**

`tsconfig.json`:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "outDir": "dist",
    "rootDir": "src",
    "strict": true,
    "declaration": true,
    "skipLibCheck": true,
    "esModuleInterop": true,
    "forceConsistentCasingInFileNames": true
  },
  "include": ["src"]
}
```

`.gitignore`:

```
node_modules/
dist/
*.log
.env
```

- [ ] **Step 3: Install dependencies**

Run: `npm install`
Expected: lockfile `package-lock.json` created, no errors. Then run `npm audit --omit=dev` and confirm no high/critical findings in runtime deps (record output in the commit message if any).

- [ ] **Step 4: Write `src/types.ts`**

```ts
// Shared types for the Slack Socket Mode plugin.

export interface SlackSocketConfig {
  slackBotTokenRef: string;
  slackAppTokenRef: string;
  companyId: string;
  defaultAgentId: string;
  defaultChannelId: string;
  notifyOnIssueCreated: boolean;
  notifyOnIssueDone: boolean;
  notifyOnAgentRunFailed: boolean;
  notifyOnApprovalCreated: boolean;
  issuesChannelId: string;
  errorsChannelId: string;
  approvalsChannelId: string;
  paperclipBaseUrl: string;
  sessionIdleHours: number;
}

export interface SessionEntry {
  sessionId: string;
  channel: string;
  threadTs: string;
  lastActivityAt: string; // ISO 8601
}

export type QuestionMode = "reaction" | "answer";

export interface PendingQuestion {
  channel: string;
  ts: string; // ts of the question message
  issueId: string;
  companyId: string;
  mode: QuestionMode;
  question: string;
  askedAt: string; // ISO 8601
  timeoutMinutes: number;
}

// --- Gateway (thin wrapper around Bolt; FakeGateway in tests) ---

export interface InboundMessage {
  channel: string;
  channelType: "im" | "channel" | "group";
  user: string;
  text: string;
  ts: string;
  threadTs?: string;
}

export interface InboundReaction {
  channel: string;
  messageTs: string;
  user: string;
  reaction: string; // emoji name without colons
}

export interface InboundAction {
  actionId: string;
  value: string;
  user: string;
  userName: string;
  channel: string;
  messageTs: string;
}

export interface InboundCommand {
  command: string; // e.g. "/paperclip"
  text: string;
  user: string;
  channel: string;
}

export interface OutboundMessage {
  channel: string;
  text: string;
  blocks?: unknown[];
  threadTs?: string;
}

export interface SlackGateway {
  start(): Promise<void>;
  stop(): Promise<void>;
  isConnected(): boolean;
  botUserId(): string | undefined;
  postMessage(msg: OutboundMessage): Promise<{ channel: string; ts: string }>;
  updateMessage(msg: { channel: string; ts: string; text: string; blocks?: unknown[] }): Promise<void>;
  postEphemeral(msg: { channel: string; user: string; text: string }): Promise<void>;
  openDm(userId: string): Promise<string>;
  getUserDisplayName(userId: string): Promise<string>;
  onMessage(handler: (msg: InboundMessage) => Promise<void>): void;
  onMention(handler: (msg: InboundMessage) => Promise<void>): void;
  onReaction(handler: (reaction: InboundReaction) => Promise<void>): void;
  onAction(pattern: RegExp, handler: (action: InboundAction) => Promise<void>): void;
  onCommand(command: string, handler: (cmd: InboundCommand) => Promise<void>): void;
}
```

- [ ] **Step 5: Write `src/constants.ts`**

```ts
import type { PluginToolDeclaration, ScopeKey } from "@paperclipai/plugin-sdk";
import type { SlackSocketConfig } from "./types.js";

export const PLUGIN_ID = "cvh.slack-socket";
export const PLUGIN_VERSION = "0.1.0";

export const ACTION_IDS = {
  approvalApprove: "approval_approve",
  approvalReject: "approval_reject",
} as const;

export const JOB_KEYS = {
  cleanup: "cleanup",
} as const;

export const TOOL_NAMES = {
  askHuman: "ask_human",
} as const;

export const SLASH_COMMAND = "/paperclip";

export const STATE_NAMESPACE = "slack-socket";

export const STATE_KEYS = {
  sessionIndex: "session-index",
  session: (channel: string, threadTs: string) => `session:${channel}:${threadTs}`,
  questionIndex: "question-index",
  question: (channel: string, ts: string) => `question:${channel}:${ts}`,
} as const;

export function stateScope(stateKey: string): ScopeKey {
  return { scopeKind: "instance", namespace: STATE_NAMESPACE, stateKey };
}

export const ASK_HUMAN_TOOL_DECLARATION: PluginToolDeclaration = {
  name: TOOL_NAMES.askHuman,
  displayName: "Ask a human via Slack",
  description:
    "Post a question to a Slack channel or user (DM). mode 'reaction' asks the human to react with an emoji; mode 'answer' asks for a text reply in the question's thread. The response is recorded as a comment on the given issue and the issue's assignee is woken.",
  parametersSchema: {
    type: "object",
    properties: {
      question: { type: "string", description: "The question to ask." },
      target: {
        type: "string",
        description: "Slack channel ID (C…) to post in, or Slack user ID (U…) to DM.",
      },
      mode: { type: "string", enum: ["reaction", "answer"] },
      issueId: { type: "string", description: "Paperclip issue UUID the response is recorded on." },
      timeoutMinutes: {
        type: "number",
        description: "Minutes to wait before marking the question expired (default 1440).",
      },
    },
    required: ["question", "target", "mode", "issueId"],
  },
};

export const DEFAULT_CONFIG: SlackSocketConfig = {
  slackBotTokenRef: "",
  slackAppTokenRef: "",
  companyId: "",
  defaultAgentId: "",
  defaultChannelId: "",
  notifyOnIssueCreated: true,
  notifyOnIssueDone: true,
  notifyOnAgentRunFailed: true,
  notifyOnApprovalCreated: true,
  issuesChannelId: "",
  errorsChannelId: "",
  approvalsChannelId: "",
  paperclipBaseUrl: "http://localhost:3010",
  sessionIdleHours: 24,
};
```

- [ ] **Step 6: Write `src/config.ts` and `src/index.ts`**

`src/config.ts`:

```ts
import type { PluginContext } from "@paperclipai/plugin-sdk";
import { DEFAULT_CONFIG } from "./constants.js";
import type { SlackSocketConfig } from "./types.js";

export async function loadConfig(ctx: PluginContext): Promise<SlackSocketConfig> {
  const raw = await ctx.config.get();
  return { ...DEFAULT_CONFIG, ...(raw as Partial<SlackSocketConfig>) };
}
```

`src/index.ts`:

```ts
export { default as manifest } from "./manifest.js";
```

Note: `src/manifest.ts` does not exist yet (Task 9). To keep this task compiling, create `src/index.ts` with the line above **commented out** and a `export {};` placeholder, and uncomment it in Task 9:

```ts
// Uncommented in the manifest task:
// export { default as manifest } from "./manifest.js";
export {};
```

- [ ] **Step 7: Typecheck**

Run: `npm run typecheck`
Expected: exit 0, no errors.

- [ ] **Step 8: Commit**

```bash
git add package.json package-lock.json tsconfig.json .gitignore src/
git commit -m "chore: scaffold paperclip-plugin-slack-socket (types, constants, config)"
```

---

### Task 2: Test helpers — mock PluginContext + FakeGateway

**Files:**
- Create: `tests/helpers.ts`

**Interfaces:**
- Consumes: `SlackGateway` and message types from `src/types.ts`; `SlackSocketConfig`, `DEFAULT_CONFIG`.
- Produces: `TEST_CONFIG: SlackSocketConfig`, `makeCtx(configOverrides?)` returning `{ ctx, stateStore, emitEvent }`, and `class FakeGateway implements SlackGateway` with `posts`, `updates`, `ephemerals`, `dmOpens`, `started` recorders and `emitMessage/emitMention/emitReaction/emitAction/emitCommand` drivers. All module tests (Tasks 3–10) depend on these exact names.

- [ ] **Step 1: Write `tests/helpers.ts`**

```ts
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
      on: vi.fn((name: string, handler: (event: unknown) => Promise<void>) => {
        const list = eventHandlers.get(name) ?? [];
        list.push(handler);
        eventHandlers.set(name, list);
      }),
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
    approvals: {
      decide: vi.fn().mockResolvedValue({ applied: true }),
    },
    tools: { register: vi.fn() },
    jobs: { register: vi.fn() },
    secrets: { resolve: vi.fn(async (ref: string) => `secret-${ref}`) },
    config: { get: vi.fn(async () => ({ ...TEST_CONFIG, ...configOverrides })) },
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
```

- [ ] **Step 2: Write a sanity test `tests/helpers.test.ts`**

```ts
import { describe, expect, it } from "vitest";
import { FakeGateway, makeCtx } from "./helpers.js";
import { stateScope } from "../src/constants.js";

describe("helpers", () => {
  it("FakeGateway records posts with incrementing ts", async () => {
    const gw = new FakeGateway();
    const first = await gw.postMessage({ channel: "C1", text: "a" });
    const second = await gw.postMessage({ channel: "C1", text: "b" });
    expect(first.ts).not.toEqual(second.ts);
    expect(gw.posts).toHaveLength(2);
  });

  it("makeCtx state round-trips through stateScope keys", async () => {
    const { ctx, stateStore } = makeCtx();
    await ctx.state.set(stateScope("k1"), { v: 1 });
    expect(await ctx.state.get(stateScope("k1"))).toEqual({ v: 1 });
    expect(stateStore.get("k1")).toEqual({ v: 1 });
  });

  it("emitEvent drives handlers registered via ctx.events.on", async () => {
    const { ctx, emitEvent } = makeCtx();
    let seen: unknown = null;
    ctx.events.on("issue.created", async (event) => { seen = event; });
    await emitEvent("issue.created", { entityId: "i1" });
    expect(seen).toEqual({ entityId: "i1" });
  });
});
```

- [ ] **Step 3: Run tests**

Run: `npx vitest run tests/helpers.test.ts`
Expected: 3 passed.

- [ ] **Step 4: Commit**

```bash
git add tests/
git commit -m "test: add mock PluginContext and FakeGateway helpers"
```

---

### Task 3: Block Kit formatters

**Files:**
- Create: `src/formatters.ts`
- Test: `tests/formatters.test.ts`

**Interfaces:**
- Consumes: `ACTION_IDS` from `src/constants.ts`.
- Produces: `SlackContent { text: string; blocks: unknown[] }` and functions `formatIssueCreated(payload, issueId, baseUrl)`, `formatIssueDone(payload, issueId, baseUrl)`, `formatAgentRunFailed(payload)`, `formatApprovalCreated(approvalId, payload, baseUrl)`, `formatApprovalDecided(approvalId, decision, deciderName)`, `formatQuestion(question, mode)`, `formatQuestionResolved(question, response, responderName)`, `formatQuestionExpired(question)`. Used by Tasks 4–8 and 10 (spread into `gateway.postMessage({ channel, ...content })`).

- [ ] **Step 1: Write the failing tests `tests/formatters.test.ts`**

```ts
import { describe, expect, it } from "vitest";
import {
  formatAgentRunFailed,
  formatApprovalCreated,
  formatApprovalDecided,
  formatIssueCreated,
  formatIssueDone,
  formatQuestion,
  formatQuestionExpired,
  formatQuestionResolved,
} from "../src/formatters.js";
import { ACTION_IDS } from "../src/constants.js";

const BASE = "https://pc.example";

describe("formatters", () => {
  it("issue created includes title and dashboard link", () => {
    const out = formatIssueCreated({ title: "Fix login", status: "todo" }, "iss-1", BASE);
    const json = JSON.stringify(out.blocks);
    expect(out.text).toContain("Fix login");
    expect(json).toContain(`${BASE}/issues/iss-1`);
  });

  it("issue done falls back to issue id when payload has no title", () => {
    const out = formatIssueDone(null, "iss-2", BASE);
    expect(out.text).toContain("iss-2");
  });

  it("agent run failed shows the error in a code block", () => {
    const out = formatAgentRunFailed({ error: "boom" });
    expect(JSON.stringify(out.blocks)).toContain("boom");
  });

  it("approval created carries approve and reject buttons with the approval id as value", () => {
    const out = formatApprovalCreated("app-1", { title: "Deploy?" }, BASE);
    const json = JSON.stringify(out.blocks);
    expect(json).toContain(ACTION_IDS.approvalApprove);
    expect(json).toContain(ACTION_IDS.approvalReject);
    expect(json).toContain('"app-1"');
  });

  it("approval decided names the decider and decision", () => {
    const approved = formatApprovalDecided("app-1", "approve", "Sam");
    const rejected = formatApprovalDecided("app-1", "reject", "Sam");
    expect(approved.text).toContain("Approved");
    expect(rejected.text).toContain("Rejected");
    expect(approved.text).toContain("Sam");
  });

  it("question prompts differ by mode", () => {
    const reaction = JSON.stringify(formatQuestion("Ship it?", "reaction").blocks);
    const answer = JSON.stringify(formatQuestion("Ship it?", "answer").blocks);
    expect(reaction.toLowerCase()).toContain("react");
    expect(answer.toLowerCase()).toContain("reply in this thread");
  });

  it("question resolved and expired reference the question", () => {
    expect(formatQuestionResolved("Ship it?", ":+1:", "Sam").text).toContain("Sam");
    expect(formatQuestionExpired("Ship it?").text.toLowerCase()).toContain("expired");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/formatters.test.ts`
Expected: FAIL — cannot resolve `../src/formatters.js`.

- [ ] **Step 3: Write `src/formatters.ts`**

```ts
import { ACTION_IDS } from "./constants.js";
import type { QuestionMode } from "./types.js";

export interface SlackContent {
  text: string;
  blocks: unknown[];
}

type Payload = Record<string, unknown> | null | undefined;

const section = (text: string) => ({ type: "section", text: { type: "mrkdwn", text } });
const context = (text: string) => ({ type: "context", elements: [{ type: "mrkdwn", text }] });

function str(payload: Payload, key: string): string {
  const value = payload?.[key];
  return typeof value === "string" ? value : "";
}

export function formatIssueCreated(payload: Payload, issueId: string, baseUrl: string): SlackContent {
  const title = str(payload, "title") || issueId;
  const meta = [
    `Status: ${str(payload, "status") || "todo"}`,
    str(payload, "priority") ? `Priority: ${str(payload, "priority")}` : "",
  ].filter(Boolean).join(" · ");
  return {
    text: `New issue created: ${title}`,
    blocks: [
      section(`:new: *Issue created*\n<${baseUrl}/issues/${issueId}|${title}>`),
      context(meta),
    ],
  };
}

export function formatIssueDone(payload: Payload, issueId: string, baseUrl: string): SlackContent {
  const title = str(payload, "title") || issueId;
  return {
    text: `Issue completed: ${title}`,
    blocks: [section(`:white_check_mark: *Issue completed*\n<${baseUrl}/issues/${issueId}|${title}>`)],
  };
}

export function formatAgentRunFailed(payload: Payload): SlackContent {
  const error = str(payload, "error") || str(payload, "message") || "Unknown error";
  const agentName = str(payload, "agentName") || str(payload, "agentId");
  return {
    text: `Agent run failed${agentName ? ` (${agentName})` : ""}`,
    blocks: [
      section(`:x: *Agent run failed*${agentName ? ` — ${agentName}` : ""}`),
      section(`\`\`\`${error.slice(0, 2800)}\`\`\``),
    ],
  };
}

export function formatApprovalCreated(approvalId: string, payload: Payload, baseUrl: string): SlackContent {
  const title = str(payload, "title") || str(payload, "description") || approvalId;
  return {
    text: `Approval requested: ${title}`,
    blocks: [
      section(`:raised_hand: *Approval requested*\n${title}`),
      {
        type: "actions",
        elements: [
          {
            type: "button",
            action_id: ACTION_IDS.approvalApprove,
            style: "primary",
            text: { type: "plain_text", text: "Approve" },
            value: approvalId,
          },
          {
            type: "button",
            action_id: ACTION_IDS.approvalReject,
            style: "danger",
            text: { type: "plain_text", text: "Reject" },
            value: approvalId,
          },
          {
            type: "button",
            text: { type: "plain_text", text: "View" },
            url: `${baseUrl}/approvals/${approvalId}`,
          },
        ],
      },
    ],
  };
}

export function formatApprovalDecided(
  approvalId: string,
  decision: "approve" | "reject",
  deciderName: string,
): SlackContent {
  const label = decision === "approve" ? ":white_check_mark: Approved" : ":no_entry: Rejected";
  const text = `${label} by ${deciderName} (approval ${approvalId})`;
  return { text, blocks: [section(text)] };
}

export function formatQuestion(question: string, mode: QuestionMode): SlackContent {
  const hint =
    mode === "reaction"
      ? "React to this message with an emoji to answer. Your reaction will be recorded on the issue."
      : "Reply in this thread to answer. Your reply will be recorded on the issue.";
  return {
    text: `Question from a Paperclip agent: ${question}`,
    blocks: [section(`:question: *A Paperclip agent asks:*\n${question}`), context(hint)],
  };
}

export function formatQuestionResolved(question: string, response: string, responderName: string): SlackContent {
  const text = `Answered by ${responderName}: ${response}`;
  return {
    text,
    blocks: [
      section(`:question: ~${question}~`),
      section(`:speech_balloon: *${responderName}* answered: ${response}`),
      context("Recorded on the issue."),
    ],
  };
}

export function formatQuestionExpired(question: string): SlackContent {
  const text = `Question expired without a response: ${question}`;
  return {
    text,
    blocks: [section(`:hourglass: ~${question}~`), context("Expired without a response.")],
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/formatters.test.ts`
Expected: 7 passed.

- [ ] **Step 5: Commit**

```bash
git add src/formatters.ts tests/formatters.test.ts
git commit -m "feat: Block Kit formatters for notifications, approvals, and questions"
```

---

### Task 4: Chat module (DM/mention → agent session)

**Files:**
- Create: `src/chat.ts`
- Test: `tests/chat.test.ts`

**Interfaces:**
- Consumes: `SlackGateway`, `SessionEntry`, `SlackSocketConfig` (Task 1); `STATE_KEYS`, `stateScope` (Task 1); mock ctx/gateway (Task 2).
- Produces: `createChat(deps: { ctx: PluginContext; gateway: SlackGateway; getConfig: () => Promise<SlackSocketConfig>; updateIntervalMs?: number }): Chat` where `Chat = { handleMention(msg): Promise<void>; handleMessage(msg): Promise<void> }`. Task 10 wires these to the gateway.

- [ ] **Step 1: Write the failing tests `tests/chat.test.ts`**

```ts
import { describe, expect, it } from "vitest";
import { createChat } from "../src/chat.js";
import { STATE_KEYS } from "../src/constants.js";
import { loadConfig } from "../src/config.js";
import { FakeGateway, makeCtx } from "./helpers.js";

function setup(configOverrides = {}) {
  const bundle = makeCtx(configOverrides);
  const gateway = new FakeGateway();
  const chat = createChat({
    ctx: bundle.ctx,
    gateway,
    getConfig: () => loadConfig(bundle.ctx),
    updateIntervalMs: 0,
  });
  return { ...bundle, gateway, chat };
}

const dm = (text: string, ts: string, threadTs?: string) => ({
  channel: "D1", channelType: "im" as const, user: "U1", text, ts, threadTs,
});

describe("chat", () => {
  it("creates a session for a new DM thread and posts the agent reply", async () => {
    const { ctx, gateway, chat, stateStore } = setup();
    await chat.handleMessage(dm("hi", "100.1"));
    expect(ctx.agents.sessions.create).toHaveBeenCalledWith("agent-1", "co-1", expect.anything());
    // placeholder post then updated with the final reply
    expect(gateway.posts[0]!.threadTs).toBe("100.1");
    expect(gateway.updates.at(-1)!.text).toBe("Hello there!");
    expect(stateStore.get(STATE_KEYS.session("D1", "100.1"))).toBeTruthy();
    expect(stateStore.get(STATE_KEYS.sessionIndex)).toContain(STATE_KEYS.session("D1", "100.1"));
  });

  it("reuses the session for a reply in the same thread", async () => {
    const { ctx, chat } = setup();
    await chat.handleMessage(dm("hi", "100.1"));
    await chat.handleMessage(dm("again", "100.2", "100.1"));
    expect(ctx.agents.sessions.create).toHaveBeenCalledTimes(1);
    expect(ctx.agents.sessions.sendMessage).toHaveBeenCalledTimes(2);
  });

  it("ignores channel messages without an existing thread session", async () => {
    const { ctx, chat } = setup();
    await chat.handleMessage({
      channel: "C1", channelType: "channel", user: "U1", text: "random chatter", ts: "1.1",
    });
    expect(ctx.agents.sessions.create).not.toHaveBeenCalled();
  });

  it("handles a channel thread reply when a session exists for the thread", async () => {
    const { ctx, chat, stateStore } = setup();
    stateStore.set(STATE_KEYS.session("C1", "50.1"), {
      sessionId: "sess-9", channel: "C1", threadTs: "50.1", lastActivityAt: new Date().toISOString(),
    });
    await chat.handleMessage({
      channel: "C1", channelType: "channel", user: "U1", text: "follow-up", ts: "50.2", threadTs: "50.1",
    });
    expect(ctx.agents.sessions.sendMessage).toHaveBeenCalledWith("sess-9", "co-1", expect.anything());
  });

  it("skips messages containing the bot mention (handled by handleMention)", async () => {
    const { ctx, chat } = setup();
    await chat.handleMessage(dm("<@UBOT> hello", "9.1"));
    expect(ctx.agents.sessions.create).not.toHaveBeenCalled();
  });

  it("strips the bot mention from mention prompts", async () => {
    const { ctx, chat } = setup();
    await chat.handleMention({
      channel: "C1", channelType: "channel", user: "U1", text: "<@UBOT> help me", ts: "2.1",
    });
    const call = (ctx.agents.sessions.sendMessage as any).mock.calls[0];
    expect(call[2].prompt).toBe("help me");
  });

  it("posts an apology in the thread when the session fails", async () => {
    const { ctx, gateway, chat } = setup();
    (ctx.agents.sessions.create as any).mockRejectedValueOnce(new Error("no agent"));
    await chat.handleMessage(dm("hi", "100.1"));
    expect(gateway.posts.at(-1)!.text).toContain("something went wrong");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/chat.test.ts`
Expected: FAIL — cannot resolve `../src/chat.js`.

- [ ] **Step 3: Write `src/chat.ts`**

```ts
import type { PluginContext } from "@paperclipai/plugin-sdk";
import { STATE_KEYS, stateScope } from "./constants.js";
import type { InboundMessage, SessionEntry, SlackGateway, SlackSocketConfig } from "./types.js";

export interface ChatDeps {
  ctx: PluginContext;
  gateway: SlackGateway;
  getConfig: () => Promise<SlackSocketConfig>;
  /** Minimum ms between streaming chat.update calls. Tests pass 0. */
  updateIntervalMs?: number;
}

export interface Chat {
  handleMention(msg: InboundMessage): Promise<void>;
  handleMessage(msg: InboundMessage): Promise<void>;
}

interface SessionEventLike {
  eventType: "chunk" | "status" | "done" | "error";
  stream: "stdout" | "stderr" | "system" | null;
  message: string | null;
}

export function createChat(deps: ChatDeps): Chat {
  const { ctx, gateway, getConfig } = deps;
  const updateIntervalMs = deps.updateIntervalMs ?? 1000;

  function stripMention(text: string): string {
    const botId = gateway.botUserId();
    return (botId ? text.replaceAll(`<@${botId}>`, "") : text).trim();
  }

  async function getOrCreateSession(
    cfg: SlackSocketConfig,
    channel: string,
    threadTs: string,
  ): Promise<SessionEntry> {
    const key = STATE_KEYS.session(channel, threadTs);
    const existing = (await ctx.state.get(stateScope(key))) as SessionEntry | null;
    if (existing) {
      const updated = { ...existing, lastActivityAt: new Date().toISOString() };
      await ctx.state.set(stateScope(key), updated);
      return updated;
    }
    const session = await ctx.agents.sessions.create(cfg.defaultAgentId, cfg.companyId, {
      reason: "slack-thread",
    });
    const entry: SessionEntry = {
      sessionId: session.sessionId,
      channel,
      threadTs,
      lastActivityAt: new Date().toISOString(),
    };
    await ctx.state.set(stateScope(key), entry);
    const index = ((await ctx.state.get(stateScope(STATE_KEYS.sessionIndex))) as string[] | null) ?? [];
    if (!index.includes(key)) {
      await ctx.state.set(stateScope(STATE_KEYS.sessionIndex), [...index, key]);
    }
    return entry;
  }

  async function streamReply(
    cfg: SlackSocketConfig,
    entry: SessionEntry,
    channel: string,
    threadTs: string,
    prompt: string,
  ): Promise<void> {
    const placeholder = await gateway.postMessage({ channel, threadTs, text: "_Thinking…_" });
    let buffer = "";
    let timer: ReturnType<typeof setTimeout> | null = null;
    let updateChain: Promise<void> = Promise.resolve();

    const pushUpdate = (text: string): void => {
      updateChain = updateChain
        .then(() => gateway.updateMessage({ channel: placeholder.channel, ts: placeholder.ts, text }))
        .catch((err) => ctx.logger.warn("Slack chat.update failed", { err: String(err) }));
    };

    const scheduleUpdate = (): void => {
      if (timer) return;
      timer = setTimeout(() => {
        timer = null;
        if (buffer) pushUpdate(buffer);
      }, updateIntervalMs);
    };

    await new Promise<void>((resolve) => {
      ctx.agents.sessions
        .sendMessage(entry.sessionId, cfg.companyId, {
          prompt,
          onEvent: (event) => {
            const e = event as SessionEventLike;
            if (e.eventType === "chunk" && e.stream === "stdout" && e.message) {
              buffer += e.message;
              scheduleUpdate();
            } else if (e.eventType === "done") {
              if (timer) { clearTimeout(timer); timer = null; }
              pushUpdate(e.message ?? (buffer || "_(no reply)_"));
              resolve();
            } else if (e.eventType === "error") {
              if (timer) { clearTimeout(timer); timer = null; }
              pushUpdate(`:warning: Agent error: ${e.message ?? "unknown error"}`);
              resolve();
            }
          },
        })
        .catch((err) => {
          pushUpdate(`:warning: Failed to reach the agent: ${String(err)}`);
          resolve();
        });
    });
    await updateChain;
  }

  async function converse(msg: InboundMessage): Promise<void> {
    const cfg = await getConfig();
    const threadTs = msg.threadTs ?? msg.ts;
    const prompt = stripMention(msg.text);
    if (!prompt) return;
    try {
      const entry = await getOrCreateSession(cfg, msg.channel, threadTs);
      await streamReply(cfg, entry, msg.channel, threadTs, prompt);
    } catch (err) {
      ctx.logger.error("Slack chat failed", { err: String(err), channel: msg.channel });
      await gateway
        .postMessage({
          channel: msg.channel,
          threadTs,
          text: ":warning: Sorry — something went wrong talking to the agent. Please try again.",
        })
        .catch(() => {});
    }
  }

  return {
    async handleMention(msg) {
      await converse(msg);
    },
    async handleMessage(msg) {
      const botId = gateway.botUserId();
      if (botId && msg.text.includes(`<@${botId}>`)) return; // the app_mention event handles it
      if (msg.channelType === "im") {
        await converse(msg);
        return;
      }
      if (!msg.threadTs) return;
      const entry = await ctx.state.get(stateScope(STATE_KEYS.session(msg.channel, msg.threadTs)));
      if (entry) await converse(msg);
    },
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/chat.test.ts`
Expected: 7 passed.

- [ ] **Step 5: Commit**

```bash
git add src/chat.ts tests/chat.test.ts
git commit -m "feat: chat module bridging Slack threads to agent sessions"
```

---

### Task 5: Notifications module

**Files:**
- Create: `src/notifications.ts`
- Test: `tests/notifications.test.ts`

**Interfaces:**
- Consumes: formatters (Task 3), `SlackGateway`, `loadConfig`-shaped `getConfig`.
- Produces: `registerNotifications(deps: { ctx; gateway; getConfig }): void` — subscribes `issue.created`, `issue.updated` (done only), `agent.run.failed`. Task 10 calls it once during setup. (Approval notifications live in Task 6.)

- [ ] **Step 1: Write the failing tests `tests/notifications.test.ts`**

```ts
import { describe, expect, it } from "vitest";
import { registerNotifications } from "../src/notifications.js";
import { loadConfig } from "../src/config.js";
import { FakeGateway, makeCtx } from "./helpers.js";

function setup(configOverrides = {}) {
  const bundle = makeCtx(configOverrides);
  const gateway = new FakeGateway();
  registerNotifications({ ctx: bundle.ctx, gateway, getConfig: () => loadConfig(bundle.ctx) });
  return { ...bundle, gateway };
}

describe("notifications", () => {
  it("posts issue.created to the default channel", async () => {
    const { gateway, emitEvent } = setup();
    await emitEvent("issue.created", { entityId: "iss-1", payload: { title: "T", status: "todo" } });
    expect(gateway.posts).toHaveLength(1);
    expect(gateway.posts[0]!.channel).toBe("C-DEFAULT");
  });

  it("respects the per-type channel override", async () => {
    const { gateway, emitEvent } = setup({ issuesChannelId: "C-ISSUES" });
    await emitEvent("issue.created", { entityId: "iss-1", payload: { title: "T" } });
    expect(gateway.posts[0]!.channel).toBe("C-ISSUES");
  });

  it("stays silent when the toggle is off", async () => {
    const { gateway, emitEvent } = setup({ notifyOnIssueCreated: false });
    await emitEvent("issue.created", { entityId: "iss-1", payload: { title: "T" } });
    expect(gateway.posts).toHaveLength(0);
  });

  it("only notifies issue.updated when status is done", async () => {
    const { gateway, emitEvent } = setup();
    await emitEvent("issue.updated", { entityId: "iss-1", payload: { status: "in_progress" } });
    expect(gateway.posts).toHaveLength(0);
    await emitEvent("issue.updated", { entityId: "iss-1", payload: { status: "done", title: "T" } });
    expect(gateway.posts).toHaveLength(1);
  });

  it("posts agent.run.failed to the errors channel override", async () => {
    const { gateway, emitEvent } = setup({ errorsChannelId: "C-ERR" });
    await emitEvent("agent.run.failed", { entityId: "run-1", payload: { error: "boom" } });
    expect(gateway.posts[0]!.channel).toBe("C-ERR");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/notifications.test.ts`
Expected: FAIL — cannot resolve `../src/notifications.js`.

- [ ] **Step 3: Write `src/notifications.ts`**

```ts
import type { PluginContext } from "@paperclipai/plugin-sdk";
import { formatAgentRunFailed, formatIssueCreated, formatIssueDone, type SlackContent } from "./formatters.js";
import type { SlackGateway, SlackSocketConfig } from "./types.js";

export interface NotificationDeps {
  ctx: PluginContext;
  gateway: SlackGateway;
  getConfig: () => Promise<SlackSocketConfig>;
}

interface EventLike {
  entityId?: string;
  payload: unknown;
}

export function registerNotifications({ ctx, gateway, getConfig }: NotificationDeps): void {
  const post = async (channel: string, content: SlackContent): Promise<void> => {
    try {
      await gateway.postMessage({ channel, ...content });
    } catch (err) {
      ctx.logger.warn("Slack notification failed", { err: String(err), channel });
    }
  };

  ctx.events.on("issue.created", async (event) => {
    const e = event as EventLike;
    const cfg = await getConfig();
    if (!cfg.notifyOnIssueCreated) return;
    const channel = cfg.issuesChannelId || cfg.defaultChannelId;
    if (!channel) return;
    await post(
      channel,
      formatIssueCreated(e.payload as Record<string, unknown>, e.entityId ?? "", cfg.paperclipBaseUrl),
    );
  });

  ctx.events.on("issue.updated", async (event) => {
    const e = event as EventLike;
    const cfg = await getConfig();
    if (!cfg.notifyOnIssueDone) return;
    const payload = e.payload as Record<string, unknown> | null;
    if (payload?.status !== "done") return;
    const channel = cfg.issuesChannelId || cfg.defaultChannelId;
    if (!channel) return;
    await post(channel, formatIssueDone(payload, e.entityId ?? "", cfg.paperclipBaseUrl));
  });

  ctx.events.on("agent.run.failed", async (event) => {
    const e = event as EventLike;
    const cfg = await getConfig();
    if (!cfg.notifyOnAgentRunFailed) return;
    const channel = cfg.errorsChannelId || cfg.defaultChannelId;
    if (!channel) return;
    await post(channel, formatAgentRunFailed(e.payload as Record<string, unknown>));
  });
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/notifications.test.ts`
Expected: 5 passed.

- [ ] **Step 5: Commit**

```bash
git add src/notifications.ts tests/notifications.test.ts
git commit -m "feat: issue and agent-failure notifications with toggles and channel routing"
```

---

### Task 6: Approvals module

**Files:**
- Create: `src/approvals.ts`
- Test: `tests/approvals.test.ts`

**Interfaces:**
- Consumes: `formatApprovalCreated`, `formatApprovalDecided` (Task 3); `ACTION_IDS` (Task 1); `ctx.approvals.decide`, `ctx.activity.log`, `ctx.metrics.write`.
- Produces: `createApprovals(deps: { ctx; gateway; getConfig }): Approvals` where `Approvals = { handleAction(action: InboundAction): Promise<void> }`; subscribes `approval.created` internally. Task 10 wires `gateway.onAction(/^approval_(approve|reject)$/, approvals.handleAction)`.

- [ ] **Step 1: Write the failing tests `tests/approvals.test.ts`**

```ts
import { describe, expect, it } from "vitest";
import { createApprovals } from "../src/approvals.js";
import { ACTION_IDS } from "../src/constants.js";
import { loadConfig } from "../src/config.js";
import { FakeGateway, makeCtx } from "./helpers.js";

function setup(configOverrides = {}) {
  const bundle = makeCtx(configOverrides);
  const gateway = new FakeGateway();
  const approvals = createApprovals({ ctx: bundle.ctx, gateway, getConfig: () => loadConfig(bundle.ctx) });
  return { ...bundle, gateway, approvals };
}

const approveAction = {
  actionId: ACTION_IDS.approvalApprove,
  value: "app-1",
  user: "U9",
  userName: "sam",
  channel: "C-APPR",
  messageTs: "77.1",
};

describe("approvals", () => {
  it("posts approval.created with buttons to the approvals channel", async () => {
    const { gateway, emitEvent } = setup({ approvalsChannelId: "C-APPR" });
    await emitEvent("approval.created", { entityId: "app-1", payload: { title: "Deploy?" } });
    expect(gateway.posts[0]!.channel).toBe("C-APPR");
    expect(JSON.stringify(gateway.posts[0]!.blocks)).toContain(ACTION_IDS.approvalApprove);
  });

  it("decides the approval and updates the message on approve", async () => {
    const { ctx, gateway, approvals } = setup();
    await approvals.handleAction(approveAction);
    expect(ctx.approvals.decide).toHaveBeenCalledWith(
      "app-1",
      expect.objectContaining({ action: "approve", decisionNote: expect.stringContaining("sam") }),
      "co-1",
    );
    expect(gateway.updates[0]!.ts).toBe("77.1");
    expect(gateway.updates[0]!.text).toContain("Approved");
    expect(ctx.activity.log).toHaveBeenCalled();
  });

  it("maps the reject action id to a reject decision", async () => {
    const { ctx, approvals } = setup();
    await approvals.handleAction({ ...approveAction, actionId: ACTION_IDS.approvalReject });
    expect(ctx.approvals.decide).toHaveBeenCalledWith(
      "app-1",
      expect.objectContaining({ action: "reject" }),
      "co-1",
    );
  });

  it("posts an ephemeral failure note when decide throws", async () => {
    const { ctx, gateway, approvals } = setup();
    (ctx.approvals.decide as any).mockRejectedValueOnce(new Error("already decided"));
    await approvals.handleAction(approveAction);
    expect(gateway.updates).toHaveLength(0);
    expect(gateway.ephemerals[0]!.user).toBe("U9");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/approvals.test.ts`
Expected: FAIL — cannot resolve `../src/approvals.js`.

- [ ] **Step 3: Write `src/approvals.ts`**

```ts
import type { PluginContext } from "@paperclipai/plugin-sdk";
import { ACTION_IDS } from "./constants.js";
import { formatApprovalCreated, formatApprovalDecided } from "./formatters.js";
import type { InboundAction, SlackGateway, SlackSocketConfig } from "./types.js";

export interface ApprovalDeps {
  ctx: PluginContext;
  gateway: SlackGateway;
  getConfig: () => Promise<SlackSocketConfig>;
}

export interface Approvals {
  handleAction(action: InboundAction): Promise<void>;
}

export function createApprovals({ ctx, gateway, getConfig }: ApprovalDeps): Approvals {
  ctx.events.on("approval.created", async (event) => {
    const e = event as { entityId?: string; payload: unknown };
    const cfg = await getConfig();
    if (!cfg.notifyOnApprovalCreated || !e.entityId) return;
    const channel = cfg.approvalsChannelId || cfg.defaultChannelId;
    if (!channel) return;
    try {
      await gateway.postMessage({
        channel,
        ...formatApprovalCreated(e.entityId, e.payload as Record<string, unknown>, cfg.paperclipBaseUrl),
      });
    } catch (err) {
      ctx.logger.warn("Slack approval notification failed", { err: String(err) });
    }
  });

  return {
    async handleAction(action) {
      const cfg = await getConfig();
      const decision = action.actionId === ACTION_IDS.approvalApprove ? "approve" : "reject";
      const approvalId = action.value;
      try {
        await ctx.approvals.decide(
          approvalId,
          { action: decision, decisionNote: `Decided via Slack by ${action.userName} (slack:${action.user})` },
          cfg.companyId,
        );
        await gateway.updateMessage({
          channel: action.channel,
          ts: action.messageTs,
          ...formatApprovalDecided(approvalId, decision, action.userName),
        });
        await ctx.activity.log({
          companyId: cfg.companyId,
          message: `Approval ${approvalId} ${decision === "approve" ? "approved" : "rejected"} via Slack by ${action.userName} (slack:${action.user})`,
          entityType: "approval",
          entityId: approvalId,
        });
        await ctx.metrics.write("slack.approvals.decided", 1, { decision });
      } catch (err) {
        ctx.logger.warn("Approval decision via Slack failed", { err: String(err), approvalId });
        await gateway
          .postEphemeral({
            channel: action.channel,
            user: action.user,
            text: `:x: Failed to ${decision} approval \`${approvalId}\`. It may already be decided.`,
          })
          .catch(() => {});
      }
    },
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/approvals.test.ts`
Expected: 4 passed.

- [ ] **Step 5: Commit**

```bash
git add src/approvals.ts tests/approvals.test.ts
git commit -m "feat: approval notifications with interactive approve/reject over Socket Mode"
```

---

### Task 7: Ask-human tool module

**Files:**
- Create: `src/ask-human.ts`
- Test: `tests/ask-human.test.ts`

**Interfaces:**
- Consumes: `ASK_HUMAN_TOOL_DECLARATION`, `TOOL_NAMES`, `STATE_KEYS`, `stateScope` (Task 1); `formatQuestion`, `formatQuestionResolved` (Task 3); `ctx.tools.register`, `ctx.issues.createComment`, `ctx.issues.requestWakeup`.
- Produces: `createAskHuman(deps: { ctx; gateway }): AskHuman` where `AskHuman = { registerTool(): void; tryHandleAnswer(msg: InboundMessage): Promise<boolean>; handleReaction(r: InboundReaction): Promise<void> }`. Task 8 reuses the `PendingQuestion` state shape for expiry; Task 10 wires the handlers (answer check runs before chat).

- [ ] **Step 1: Write the failing tests `tests/ask-human.test.ts`**

```ts
import { describe, expect, it } from "vitest";
import { createAskHuman } from "../src/ask-human.js";
import { STATE_KEYS, TOOL_NAMES } from "../src/constants.js";
import type { PendingQuestion } from "../src/types.js";
import { FakeGateway, makeCtx } from "./helpers.js";

const RUN_CTX = { agentId: "agent-1", runId: "run-1", companyId: "co-1", projectId: "proj-1" };

function setup() {
  const bundle = makeCtx();
  const gateway = new FakeGateway();
  const askHuman = createAskHuman({ ctx: bundle.ctx, gateway });
  askHuman.registerTool();
  const toolCall = (bundle.ctx.tools.register as any).mock.calls[0];
  const handler = toolCall[2] as (params: unknown, runCtx: typeof RUN_CTX) => Promise<{ content?: string; error?: string }>;
  return { ...bundle, gateway, askHuman, toolName: toolCall[0] as string, handler };
}

const pending = (overrides: Partial<PendingQuestion> = {}): PendingQuestion => ({
  channel: "C1", ts: "10.1", issueId: "iss-1", companyId: "co-1",
  mode: "reaction", question: "Ship it?", askedAt: new Date().toISOString(), timeoutMinutes: 60,
  ...overrides,
});

describe("ask-human tool", () => {
  it("registers under the ask_human name and posts the question to a channel", async () => {
    const { toolName, handler, gateway, stateStore } = setup();
    expect(toolName).toBe(TOOL_NAMES.askHuman);
    const result = await handler(
      { question: "Ship it?", target: "C1", mode: "reaction", issueId: "iss-1" }, RUN_CTX,
    );
    expect(result.error).toBeUndefined();
    expect(gateway.posts).toHaveLength(1);
    const key = STATE_KEYS.question("C1", gateway.posts[0]!.ts);
    expect(stateStore.get(key)).toMatchObject({ issueId: "iss-1", mode: "reaction", companyId: "co-1" });
    expect(stateStore.get(STATE_KEYS.questionIndex)).toContain(key);
  });

  it("opens a DM when the target is a user id", async () => {
    const { handler, gateway } = setup();
    await handler({ question: "Q?", target: "U77", mode: "answer", issueId: "iss-1" }, RUN_CTX);
    expect(gateway.dmOpens).toEqual(["U77"]);
    expect(gateway.posts[0]!.channel).toBe("D-U77");
  });

  it("rejects missing params without posting", async () => {
    const { handler, gateway } = setup();
    const result = await handler({ question: "Q?" }, RUN_CTX);
    expect(result.error).toBeTruthy();
    expect(gateway.posts).toHaveLength(0);
  });

  it("records a reaction response, wakes the issue, and resolves the message", async () => {
    const { ctx, gateway, askHuman, stateStore } = setup();
    const key = STATE_KEYS.question("C1", "10.1");
    stateStore.set(key, pending());
    stateStore.set(STATE_KEYS.questionIndex, [key]);
    await askHuman.handleReaction({ channel: "C1", messageTs: "10.1", user: "U5", reaction: "+1" });
    expect(ctx.issues.createComment).toHaveBeenCalledWith(
      "iss-1", expect.stringContaining(":+1:"), "co-1",
    );
    expect(ctx.issues.requestWakeup).toHaveBeenCalledWith("iss-1", "co-1", expect.anything());
    expect(gateway.updates[0]!.ts).toBe("10.1");
    expect(stateStore.get(key)).toBeUndefined();
    expect(stateStore.get(STATE_KEYS.questionIndex)).toEqual([]);
  });

  it("ignores reactions when the pending question is answer-mode", async () => {
    const { ctx, askHuman, stateStore } = setup();
    stateStore.set(STATE_KEYS.question("C1", "10.1"), pending({ mode: "answer" }));
    await askHuman.handleReaction({ channel: "C1", messageTs: "10.1", user: "U5", reaction: "+1" });
    expect(ctx.issues.createComment).not.toHaveBeenCalled();
  });

  it("claims thread replies to answer-mode questions and records them", async () => {
    const { ctx, askHuman, stateStore } = setup();
    const key = STATE_KEYS.question("C1", "10.1");
    stateStore.set(key, pending({ mode: "answer" }));
    stateStore.set(STATE_KEYS.questionIndex, [key]);
    const claimed = await askHuman.tryHandleAnswer({
      channel: "C1", channelType: "channel", user: "U5", text: "Yes, ship it", ts: "10.2", threadTs: "10.1",
    });
    expect(claimed).toBe(true);
    expect(ctx.issues.createComment).toHaveBeenCalledWith(
      "iss-1", expect.stringContaining("Yes, ship it"), "co-1",
    );
  });

  it("does not claim unrelated messages", async () => {
    const { askHuman } = setup();
    const claimed = await askHuman.tryHandleAnswer({
      channel: "C1", channelType: "channel", user: "U5", text: "hello", ts: "1.2", threadTs: "1.1",
    });
    expect(claimed).toBe(false);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/ask-human.test.ts`
Expected: FAIL — cannot resolve `../src/ask-human.js`.

- [ ] **Step 3: Write `src/ask-human.ts`**

```ts
import type { PluginContext } from "@paperclipai/plugin-sdk";
import { ASK_HUMAN_TOOL_DECLARATION, STATE_KEYS, TOOL_NAMES, stateScope } from "./constants.js";
import { formatQuestion, formatQuestionResolved } from "./formatters.js";
import type { InboundMessage, InboundReaction, PendingQuestion, SlackGateway } from "./types.js";

export interface AskHumanDeps {
  ctx: PluginContext;
  gateway: SlackGateway;
}

export interface AskHuman {
  registerTool(): void;
  /** Returns true when the message was an answer to a pending question (callers must stop routing it). */
  tryHandleAnswer(msg: InboundMessage): Promise<boolean>;
  handleReaction(reaction: InboundReaction): Promise<void>;
}

export function createAskHuman({ ctx, gateway }: AskHumanDeps): AskHuman {
  async function resolvePending(
    key: string,
    pending: PendingQuestion,
    response: string,
    responderName: string,
  ): Promise<void> {
    const body = `Slack response from ${responderName} to: "${pending.question}"\n\n${response}`;
    await ctx.issues.createComment(pending.issueId, body, pending.companyId);
    try {
      await ctx.issues.requestWakeup(pending.issueId, pending.companyId, {
        reason: "slack_ask_human_response",
        contextSource: "slack-socket.ask-human",
      });
    } catch (err) {
      ctx.logger.warn("Wakeup after Slack answer failed", { err: String(err), issueId: pending.issueId });
    }
    await gateway.updateMessage({
      channel: pending.channel,
      ts: pending.ts,
      ...formatQuestionResolved(pending.question, response, responderName),
    });
    await ctx.state.delete(stateScope(key));
    const index = ((await ctx.state.get(stateScope(STATE_KEYS.questionIndex))) as string[] | null) ?? [];
    await ctx.state.set(stateScope(STATE_KEYS.questionIndex), index.filter((k) => k !== key));
    await ctx.metrics.write("slack.questions.answered", 1, { mode: pending.mode });
  }

  return {
    registerTool() {
      ctx.tools.register(
        TOOL_NAMES.askHuman,
        {
          displayName: ASK_HUMAN_TOOL_DECLARATION.displayName,
          description: ASK_HUMAN_TOOL_DECLARATION.description,
          parametersSchema: ASK_HUMAN_TOOL_DECLARATION.parametersSchema,
        },
        async (params, runCtx) => {
          const p = (params ?? {}) as Record<string, unknown>;
          const question = typeof p.question === "string" ? p.question.trim() : "";
          const target = typeof p.target === "string" ? p.target.trim() : "";
          const mode = p.mode === "reaction" || p.mode === "answer" ? p.mode : null;
          const issueId = typeof p.issueId === "string" ? p.issueId : "";
          const timeoutMinutes =
            typeof p.timeoutMinutes === "number" && p.timeoutMinutes > 0 ? p.timeoutMinutes : 1440;
          if (!question || !target || !mode || !issueId) {
            return { error: "question, target, mode and issueId are required" };
          }
          try {
            const channel = target.startsWith("U") ? await gateway.openDm(target) : target;
            const posted = await gateway.postMessage({ channel, ...formatQuestion(question, mode) });
            const key = STATE_KEYS.question(posted.channel, posted.ts);
            const pending: PendingQuestion = {
              channel: posted.channel,
              ts: posted.ts,
              issueId,
              companyId: runCtx.companyId,
              mode,
              question,
              askedAt: new Date().toISOString(),
              timeoutMinutes,
            };
            await ctx.state.set(stateScope(key), pending);
            const index =
              ((await ctx.state.get(stateScope(STATE_KEYS.questionIndex))) as string[] | null) ?? [];
            await ctx.state.set(stateScope(STATE_KEYS.questionIndex), [...index, key]);
            await ctx.metrics.write("slack.questions.asked", 1, { mode });
            return {
              content: `Question posted to Slack channel ${posted.channel}. The response will be recorded as a comment on issue ${issueId}.`,
              data: { channel: posted.channel, ts: posted.ts },
            };
          } catch (err) {
            return { error: `Failed to post question to Slack: ${String(err)}` };
          }
        },
      );
    },

    async tryHandleAnswer(msg) {
      if (!msg.threadTs || msg.threadTs === msg.ts) return false;
      const key = STATE_KEYS.question(msg.channel, msg.threadTs);
      const pending = (await ctx.state.get(stateScope(key))) as PendingQuestion | null;
      if (!pending || pending.mode !== "answer") return false;
      const name = await gateway.getUserDisplayName(msg.user);
      await resolvePending(key, pending, msg.text, name);
      return true;
    },

    async handleReaction(reaction) {
      const key = STATE_KEYS.question(reaction.channel, reaction.messageTs);
      const pending = (await ctx.state.get(stateScope(key))) as PendingQuestion | null;
      if (!pending || pending.mode !== "reaction") return;
      const name = await gateway.getUserDisplayName(reaction.user);
      await resolvePending(key, pending, `:${reaction.reaction}:`, name);
    },
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/ask-human.test.ts`
Expected: 7 passed.

- [ ] **Step 5: Commit**

```bash
git add src/ask-human.ts tests/ask-human.test.ts
git commit -m "feat: ask_human agent tool with reaction and thread-answer modes"
```

---

### Task 8: Slash command + cleanup job

**Files:**
- Create: `src/commands.ts`, `src/cleanup.ts`
- Test: `tests/commands.test.ts`, `tests/cleanup.test.ts`

**Interfaces:**
- Consumes: `SLASH_COMMAND`, `STATE_KEYS`, `stateScope`, `SessionEntry`, `PendingQuestion`, `formatQuestionExpired`; `ctx.issues.create`, `ctx.agents.sessions.close`, `ctx.issues.createComment`.
- Produces: `createCommands(deps: { ctx; gateway; getConfig }): Commands` with `Commands = { handleCommand(cmd: InboundCommand): Promise<void> }`; `runCleanup(ctx, gateway, cfg): Promise<void>`. Task 10 wires the command handler and registers `runCleanup` under the `cleanup` job key.

- [ ] **Step 1: Write the failing tests `tests/commands.test.ts`**

```ts
import { describe, expect, it } from "vitest";
import { createCommands } from "../src/commands.js";
import { loadConfig } from "../src/config.js";
import { FakeGateway, makeCtx } from "./helpers.js";

function setup() {
  const bundle = makeCtx();
  const gateway = new FakeGateway();
  const commands = createCommands({ ctx: bundle.ctx, gateway, getConfig: () => loadConfig(bundle.ctx) });
  return { ...bundle, gateway, commands };
}

const cmd = (text: string) => ({ command: "/paperclip", text, user: "U1", channel: "C1" });

describe("commands", () => {
  it("creates an issue and replies ephemerally with a link", async () => {
    const { ctx, gateway, commands } = setup();
    await commands.handleCommand(cmd("issue Fix the login flow"));
    expect(ctx.issues.create).toHaveBeenCalledWith({
      companyId: "co-1", title: "Fix the login flow", status: "todo",
    });
    expect(gateway.ephemerals[0]!.text).toContain("https://pc.example/issues/issue-1");
  });

  it("shows usage when the title is missing", async () => {
    const { ctx, gateway, commands } = setup();
    await commands.handleCommand(cmd("issue"));
    expect(ctx.issues.create).not.toHaveBeenCalled();
    expect(gateway.ephemerals[0]!.text).toContain("Usage");
  });

  it("replies with help for anything else", async () => {
    const { gateway, commands } = setup();
    await commands.handleCommand(cmd("help"));
    expect(gateway.ephemerals[0]!.text).toContain("/paperclip issue");
  });

  it("reports failure ephemerally when issue creation throws", async () => {
    const { ctx, gateway, commands } = setup();
    (ctx.issues.create as any).mockRejectedValueOnce(new Error("nope"));
    await commands.handleCommand(cmd("issue X"));
    expect(gateway.ephemerals[0]!.text).toContain("Failed");
  });
});
```

- [ ] **Step 2: Write the failing tests `tests/cleanup.test.ts`**

```ts
import { describe, expect, it } from "vitest";
import { runCleanup } from "../src/cleanup.js";
import { STATE_KEYS } from "../src/constants.js";
import type { PendingQuestion, SessionEntry } from "../src/types.js";
import { FakeGateway, makeCtx, TEST_CONFIG } from "./helpers.js";

const HOURS = 3_600_000;

function session(threadTs: string, ageMs: number): SessionEntry {
  return {
    sessionId: `sess-${threadTs}`, channel: "C1", threadTs,
    lastActivityAt: new Date(Date.now() - ageMs).toISOString(),
  };
}

describe("runCleanup", () => {
  it("closes idle sessions and keeps fresh ones", async () => {
    const { ctx, stateStore } = makeCtx();
    const staleKey = STATE_KEYS.session("C1", "1.1");
    const freshKey = STATE_KEYS.session("C1", "2.1");
    stateStore.set(staleKey, session("1.1", 25 * HOURS));
    stateStore.set(freshKey, session("2.1", 1 * HOURS));
    stateStore.set(STATE_KEYS.sessionIndex, [staleKey, freshKey]);

    await runCleanup(ctx, new FakeGateway(), TEST_CONFIG);

    expect(ctx.agents.sessions.close).toHaveBeenCalledWith("sess-1.1", "co-1");
    expect(ctx.agents.sessions.close).toHaveBeenCalledTimes(1);
    expect(stateStore.get(staleKey)).toBeUndefined();
    expect(stateStore.get(STATE_KEYS.sessionIndex)).toEqual([freshKey]);
  });

  it("expires timed-out questions: comment, Slack update, state removal", async () => {
    const { ctx, stateStore } = makeCtx();
    const gateway = new FakeGateway();
    const key = STATE_KEYS.question("C1", "10.1");
    const expired: PendingQuestion = {
      channel: "C1", ts: "10.1", issueId: "iss-1", companyId: "co-1", mode: "answer",
      question: "Ship it?", askedAt: new Date(Date.now() - 2 * HOURS).toISOString(), timeoutMinutes: 60,
    };
    stateStore.set(key, expired);
    stateStore.set(STATE_KEYS.questionIndex, [key]);

    await runCleanup(ctx, gateway, TEST_CONFIG);

    expect(ctx.issues.createComment).toHaveBeenCalledWith(
      "iss-1", expect.stringContaining("No Slack response"), "co-1",
    );
    expect(gateway.updates[0]!.ts).toBe("10.1");
    expect(stateStore.get(key)).toBeUndefined();
    expect(stateStore.get(STATE_KEYS.questionIndex)).toEqual([]);
  });

  it("keeps questions still inside their timeout", async () => {
    const { ctx, stateStore } = makeCtx();
    const key = STATE_KEYS.question("C1", "10.1");
    stateStore.set(key, {
      channel: "C1", ts: "10.1", issueId: "iss-1", companyId: "co-1", mode: "answer",
      question: "Q?", askedAt: new Date().toISOString(), timeoutMinutes: 60,
    } satisfies PendingQuestion);
    stateStore.set(STATE_KEYS.questionIndex, [key]);

    await runCleanup(ctx, new FakeGateway(), TEST_CONFIG);

    expect(ctx.issues.createComment).not.toHaveBeenCalled();
    expect(stateStore.get(STATE_KEYS.questionIndex)).toEqual([key]);
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `npx vitest run tests/commands.test.ts tests/cleanup.test.ts`
Expected: FAIL — cannot resolve `../src/commands.js` / `../src/cleanup.js`.

- [ ] **Step 4: Write `src/commands.ts`**

```ts
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
```

- [ ] **Step 5: Write `src/cleanup.ts`**

```ts
import type { PluginContext } from "@paperclipai/plugin-sdk";
import { STATE_KEYS, stateScope } from "./constants.js";
import { formatQuestionExpired } from "./formatters.js";
import type { PendingQuestion, SessionEntry, SlackGateway, SlackSocketConfig } from "./types.js";

export async function runCleanup(
  ctx: PluginContext,
  gateway: SlackGateway,
  cfg: SlackSocketConfig,
): Promise<void> {
  const now = Date.now();

  const sessionIndex =
    ((await ctx.state.get(stateScope(STATE_KEYS.sessionIndex))) as string[] | null) ?? [];
  const keepSessions: string[] = [];
  for (const key of sessionIndex) {
    const entry = (await ctx.state.get(stateScope(key))) as SessionEntry | null;
    if (!entry) continue;
    const idleMs = now - Date.parse(entry.lastActivityAt);
    if (idleMs > cfg.sessionIdleHours * 3_600_000) {
      try {
        await ctx.agents.sessions.close(entry.sessionId, cfg.companyId);
      } catch (err) {
        ctx.logger.warn("Failed to close idle session", { err: String(err), sessionId: entry.sessionId });
      }
      await ctx.state.delete(stateScope(key));
    } else {
      keepSessions.push(key);
    }
  }
  await ctx.state.set(stateScope(STATE_KEYS.sessionIndex), keepSessions);

  const questionIndex =
    ((await ctx.state.get(stateScope(STATE_KEYS.questionIndex))) as string[] | null) ?? [];
  const keepQuestions: string[] = [];
  for (const key of questionIndex) {
    const pending = (await ctx.state.get(stateScope(key))) as PendingQuestion | null;
    if (!pending) continue;
    const ageMs = now - Date.parse(pending.askedAt);
    if (ageMs > pending.timeoutMinutes * 60_000) {
      try {
        await ctx.issues.createComment(
          pending.issueId,
          `No Slack response to: "${pending.question}" within ${pending.timeoutMinutes} minutes.`,
          pending.companyId,
        );
        await gateway.updateMessage({
          channel: pending.channel,
          ts: pending.ts,
          ...formatQuestionExpired(pending.question),
        });
      } catch (err) {
        ctx.logger.warn("Failed to expire question", { err: String(err) });
      }
      await ctx.state.delete(stateScope(key));
    } else {
      keepQuestions.push(key);
    }
  }
  await ctx.state.set(stateScope(STATE_KEYS.questionIndex), keepQuestions);
}
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `npx vitest run tests/commands.test.ts tests/cleanup.test.ts`
Expected: 7 passed.

- [ ] **Step 7: Commit**

```bash
git add src/commands.ts src/cleanup.ts tests/commands.test.ts tests/cleanup.test.ts
git commit -m "feat: /paperclip slash command and idle-session/question cleanup job"
```

---

### Task 9: Plugin manifest

**Files:**
- Create: `src/manifest.ts`
- Modify: `src/index.ts` (uncomment the manifest export from Task 1)
- Test: `tests/manifest.test.ts`

**Interfaces:**
- Consumes: `PLUGIN_ID`, `PLUGIN_VERSION`, `JOB_KEYS`, `ASK_HUMAN_TOOL_DECLARATION`, `DEFAULT_CONFIG`.
- Produces: default-export manifest (`PaperclipPluginManifestV1`). Task 10's worker relies on job key `cleanup` and the tool declaration matching `ctx.tools.register`.

- [ ] **Step 1: Write the failing tests `tests/manifest.test.ts`**

```ts
import { describe, expect, it } from "vitest";
import manifest from "../src/manifest.js";
import { JOB_KEYS, TOOL_NAMES } from "../src/constants.js";

describe("manifest", () => {
  it("declares no webhooks (Socket Mode only)", () => {
    expect(manifest.webhooks ?? []).toHaveLength(0);
  });

  it("declares the exact least-privilege capability set", () => {
    expect([...manifest.capabilities].sort()).toEqual(
      [
        "companies.read", "issues.read", "issues.create", "issue.comments.create", "issues.wakeup",
        "agents.read", "agent.sessions.create", "agent.sessions.send", "agent.sessions.close",
        "agent.tools.register", "approvals.read", "approvals.respond", "events.subscribe",
        "plugin.state.read", "plugin.state.write", "secrets.read-ref", "instance.settings.register",
        "activity.log.write", "metrics.write", "jobs.schedule",
      ].sort(),
    );
  });

  it("declares the cleanup job and the ask_human tool", () => {
    expect(manifest.jobs?.map((j) => j.jobKey)).toEqual([JOB_KEYS.cleanup]);
    expect(manifest.tools?.map((t) => t.name)).toEqual([TOOL_NAMES.askHuman]);
  });

  it("requires tokens, company, agent, and default channel in config", () => {
    const schema = manifest.instanceConfigSchema as { required?: string[] };
    expect(schema.required).toEqual([
      "slackBotTokenRef", "slackAppTokenRef", "companyId", "defaultAgentId", "defaultChannelId",
    ]);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/manifest.test.ts`
Expected: FAIL — cannot resolve `../src/manifest.js`.

- [ ] **Step 3: Write `src/manifest.ts`**

```ts
import type { PaperclipPluginManifestV1 } from "@paperclipai/plugin-sdk";
import {
  ASK_HUMAN_TOOL_DECLARATION,
  DEFAULT_CONFIG,
  JOB_KEYS,
  PLUGIN_ID,
  PLUGIN_VERSION,
} from "./constants.js";

const manifest: PaperclipPluginManifestV1 = {
  id: PLUGIN_ID,
  apiVersion: 1,
  version: PLUGIN_VERSION,
  displayName: "Slack (Socket Mode)",
  description:
    "Connect Slack over Socket Mode — no public URL required. Chat with a Paperclip agent in DMs and mentions, get configurable notifications, decide approvals with buttons, let agents ask humans questions, and create issues with /paperclip.",
  author: "cvh",
  categories: ["connector", "automation"],
  capabilities: [
    "companies.read",
    "issues.read",
    "issues.create",
    "issue.comments.create",
    "issues.wakeup",
    "agents.read",
    "agent.sessions.create",
    "agent.sessions.send",
    "agent.sessions.close",
    "agent.tools.register",
    "approvals.read",
    "approvals.respond",
    "events.subscribe",
    "plugin.state.read",
    "plugin.state.write",
    "secrets.read-ref",
    "instance.settings.register",
    "activity.log.write",
    "metrics.write",
    "jobs.schedule",
  ],
  entrypoints: {
    worker: "./dist/worker.js",
  },
  instanceConfigSchema: {
    type: "object",
    properties: {
      slackBotTokenRef: {
        type: "string",
        format: "secret-ref",
        title: "Slack Bot Token (secret reference)",
        description:
          "Secret UUID holding your Slack Bot OAuth token (xoxb-…). Create the secret in Settings → Secrets, then paste its UUID here.",
        default: DEFAULT_CONFIG.slackBotTokenRef,
      },
      slackAppTokenRef: {
        type: "string",
        format: "secret-ref",
        title: "Slack App-Level Token (secret reference)",
        description:
          "Secret UUID holding your Slack App-Level token (xapp-…) with the connections:write scope.",
        default: DEFAULT_CONFIG.slackAppTokenRef,
      },
      companyId: {
        type: "string",
        title: "Company ID",
        description: "Paperclip company UUID used for sessions, issues, and approvals.",
        default: DEFAULT_CONFIG.companyId,
      },
      defaultAgentId: {
        type: "string",
        title: "Default Agent ID",
        description: "Agent that handles DM and @mention conversations.",
        default: DEFAULT_CONFIG.defaultAgentId,
      },
      defaultChannelId: {
        type: "string",
        title: "Default Slack Channel ID",
        description: "Fallback channel for notifications (e.g. C01ABC2DEF3).",
        default: DEFAULT_CONFIG.defaultChannelId,
      },
      notifyOnIssueCreated: {
        type: "boolean",
        title: "Notify on issue created",
        default: DEFAULT_CONFIG.notifyOnIssueCreated,
      },
      notifyOnIssueDone: {
        type: "boolean",
        title: "Notify on issue completed",
        default: DEFAULT_CONFIG.notifyOnIssueDone,
      },
      notifyOnAgentRunFailed: {
        type: "boolean",
        title: "Notify on agent run failure",
        default: DEFAULT_CONFIG.notifyOnAgentRunFailed,
      },
      notifyOnApprovalCreated: {
        type: "boolean",
        title: "Notify on approval requested",
        default: DEFAULT_CONFIG.notifyOnApprovalCreated,
      },
      issuesChannelId: {
        type: "string",
        title: "Issues Channel ID",
        description: "Optional channel for issue notifications (falls back to default).",
        default: DEFAULT_CONFIG.issuesChannelId,
      },
      errorsChannelId: {
        type: "string",
        title: "Errors Channel ID",
        description: "Optional channel for agent failure notifications (falls back to default).",
        default: DEFAULT_CONFIG.errorsChannelId,
      },
      approvalsChannelId: {
        type: "string",
        title: "Approvals Channel ID",
        description: "Optional channel for approval notifications (falls back to default).",
        default: DEFAULT_CONFIG.approvalsChannelId,
      },
      paperclipBaseUrl: {
        type: "string",
        title: "Paperclip Base URL",
        description: "Base URL of your Paperclip instance, used for dashboard links.",
        default: DEFAULT_CONFIG.paperclipBaseUrl,
      },
      sessionIdleHours: {
        type: "number",
        title: "Session Idle Hours",
        description: "Close agent sessions idle longer than this many hours.",
        default: DEFAULT_CONFIG.sessionIdleHours,
      },
    },
    required: ["slackBotTokenRef", "slackAppTokenRef", "companyId", "defaultAgentId", "defaultChannelId"],
  },
  jobs: [
    {
      jobKey: JOB_KEYS.cleanup,
      displayName: "Cleanup idle sessions and expired questions",
      description: "Closes agent sessions idle beyond the configured TTL and expires unanswered ask-human questions.",
      schedule: "*/15 * * * *",
    },
  ],
  tools: [ASK_HUMAN_TOOL_DECLARATION],
};

export default manifest;
```

- [ ] **Step 4: Update `src/index.ts`**

```ts
export { default as manifest } from "./manifest.js";
```

- [ ] **Step 5: Run tests and typecheck**

Run: `npx vitest run tests/manifest.test.ts && npm run typecheck`
Expected: 4 passed; typecheck exit 0.

- [ ] **Step 6: Commit**

```bash
git add src/manifest.ts src/index.ts tests/manifest.test.ts
git commit -m "feat: plugin manifest — Socket Mode, zero webhooks, least-privilege capabilities"
```

---

### Task 10: Bolt gateway + worker wiring

**Files:**
- Create: `src/bolt-gateway.ts`, `src/worker.ts`
- Test: `tests/worker.test.ts`

**Interfaces:**
- Consumes: every module from Tasks 1–9; `@slack/bolt` `App`; `@slack/web-api` `WebClient` (validation only).
- Produces: `BoltGateway implements SlackGateway`; worker default export (`definePlugin`) plus exported `startRuntime(ctx, makeGateway)` and `GatewayFactory` for tests. `dist/worker.js` is the manifest's worker entrypoint.

**Note:** `BoltGateway` is a thin adapter over Bolt and is exercised by the manual smoke test (Task 11), not unit tests. All logic on our side of the interface is already unit-tested against `FakeGateway`.

- [ ] **Step 1: Write the failing tests `tests/worker.test.ts`**

```ts
import { describe, expect, it } from "vitest";
import { startRuntime } from "../src/worker.js";
import { JOB_KEYS, SLASH_COMMAND, TOOL_NAMES } from "../src/constants.js";
import { FakeGateway, makeCtx } from "./helpers.js";

describe("startRuntime", () => {
  it("stays degraded and does not start the gateway when unconfigured", async () => {
    const { ctx } = makeCtx({ slackBotTokenRef: "", companyId: "" });
    const gateway = new FakeGateway();
    const health = await startRuntime(ctx, () => gateway);
    expect(health.status).toBe("degraded");
    expect(gateway.started).toBe(false);
  });

  it("goes degraded when secret resolution fails", async () => {
    const { ctx } = makeCtx();
    (ctx.secrets.resolve as any).mockRejectedValue(new Error("secrets disabled"));
    const gateway = new FakeGateway();
    const health = await startRuntime(ctx, () => gateway);
    expect(health.status).toBe("degraded");
    expect(gateway.started).toBe(false);
  });

  it("starts the gateway, registers the tool, job, command and action handlers when configured", async () => {
    const { ctx } = makeCtx();
    const gateway = new FakeGateway();
    const health = await startRuntime(ctx, (opts) => {
      expect(opts.botToken).toBe("secret-ref-bot");
      expect(opts.appToken).toBe("secret-ref-app");
      return gateway;
    });
    expect(health.status).toBe("ok");
    expect(gateway.started).toBe(true);
    expect((ctx.tools.register as any).mock.calls[0][0]).toBe(TOOL_NAMES.askHuman);
    expect((ctx.jobs.register as any).mock.calls[0][0]).toBe(JOB_KEYS.cleanup);
    // end-to-end through the wiring: a slash command reaches the commands module
    await gateway.emitCommand({ command: SLASH_COMMAND, text: "help", user: "U1", channel: "C1" });
    expect(gateway.ephemerals).toHaveLength(1);
  });

  it("routes answer-mode question replies away from chat", async () => {
    const { ctx, stateStore } = makeCtx();
    const gateway = new FakeGateway();
    await startRuntime(ctx, () => gateway);
    const { STATE_KEYS } = await import("../src/constants.js");
    stateStore.set(STATE_KEYS.question("C1", "10.1"), {
      channel: "C1", ts: "10.1", issueId: "iss-1", companyId: "co-1", mode: "answer",
      question: "Q?", askedAt: new Date().toISOString(), timeoutMinutes: 60,
    });
    await gateway.emitMessage({
      channel: "C1", channelType: "channel", user: "U5", text: "the answer", ts: "10.2", threadTs: "10.1",
    });
    expect(ctx.issues.createComment).toHaveBeenCalled();
    expect(ctx.agents.sessions.sendMessage).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/worker.test.ts`
Expected: FAIL — cannot resolve `../src/worker.js`.

- [ ] **Step 3: Write `src/bolt-gateway.ts`**

```ts
import boltPkg from "@slack/bolt";
import type {
  InboundAction,
  InboundCommand,
  InboundMessage,
  InboundReaction,
  OutboundMessage,
  SlackGateway,
} from "./types.js";

const { App } = boltPkg;

interface GatewayLogger {
  warn(message: string, data?: Record<string, unknown>): void;
}

export class BoltGateway implements SlackGateway {
  private readonly app: InstanceType<typeof App>;
  private readonly logger: GatewayLogger;
  private connected = false;
  private botId: string | undefined;
  private messageHandlers: Array<(msg: InboundMessage) => Promise<void>> = [];
  private mentionHandlers: Array<(msg: InboundMessage) => Promise<void>> = [];
  private reactionHandlers: Array<(r: InboundReaction) => Promise<void>> = [];

  constructor(opts: { botToken: string; appToken: string; logger: GatewayLogger }) {
    this.logger = opts.logger;
    this.app = new App({ token: opts.botToken, appToken: opts.appToken, socketMode: true });

    this.app.event("app_mention", async ({ event }) => {
      const e = event as { channel: string; user?: string; text?: string; ts: string; thread_ts?: string };
      await this.dispatch(this.mentionHandlers, {
        channel: e.channel,
        channelType: "channel",
        user: e.user ?? "",
        text: e.text ?? "",
        ts: e.ts,
        threadTs: e.thread_ts,
      });
    });

    this.app.message(async ({ message }) => {
      const m = message as {
        subtype?: string; bot_id?: string; channel: string; channel_type?: string;
        user?: string; text?: string; ts: string; thread_ts?: string;
      };
      if (m.subtype || m.bot_id || !m.user) return;
      const channelType = m.channel_type === "im" ? "im" : m.channel_type === "group" ? "group" : "channel";
      await this.dispatch(this.messageHandlers, {
        channel: m.channel,
        channelType,
        user: m.user,
        text: m.text ?? "",
        ts: m.ts,
        threadTs: m.thread_ts,
      });
    });

    this.app.event("reaction_added", async ({ event }) => {
      const e = event as { user: string; reaction: string; item: { type: string; channel?: string; ts?: string } };
      if (e.item.type !== "message" || !e.item.channel || !e.item.ts) return;
      await this.dispatch(this.reactionHandlers, {
        channel: e.item.channel,
        messageTs: e.item.ts,
        user: e.user,
        reaction: e.reaction,
      });
    });
  }

  private async dispatch<T>(handlers: Array<(payload: T) => Promise<void>>, payload: T): Promise<void> {
    for (const handler of handlers) {
      try {
        await handler(payload);
      } catch (err) {
        this.logger.warn("Slack handler failed", { err: String(err) });
      }
    }
  }

  onMessage(handler: (msg: InboundMessage) => Promise<void>): void { this.messageHandlers.push(handler); }
  onMention(handler: (msg: InboundMessage) => Promise<void>): void { this.mentionHandlers.push(handler); }
  onReaction(handler: (r: InboundReaction) => Promise<void>): void { this.reactionHandlers.push(handler); }

  onAction(pattern: RegExp, handler: (action: InboundAction) => Promise<void>): void {
    this.app.action(pattern, async ({ ack, body, action }) => {
      await ack();
      const b = body as {
        user?: { id?: string; name?: string; username?: string };
        channel?: { id?: string };
        message?: { ts?: string };
      };
      const a = action as { action_id?: string; value?: string };
      try {
        await handler({
          actionId: a.action_id ?? "",
          value: a.value ?? "",
          user: b.user?.id ?? "",
          userName: b.user?.name ?? b.user?.username ?? b.user?.id ?? "unknown",
          channel: b.channel?.id ?? "",
          messageTs: b.message?.ts ?? "",
        });
      } catch (err) {
        this.logger.warn("Slack action handler failed", { err: String(err) });
      }
    });
  }

  onCommand(command: string, handler: (cmd: InboundCommand) => Promise<void>): void {
    this.app.command(command, async ({ ack, command: cmd }) => {
      await ack();
      try {
        await handler({ command: cmd.command, text: cmd.text ?? "", user: cmd.user_id, channel: cmd.channel_id });
      } catch (err) {
        this.logger.warn("Slack command handler failed", { err: String(err) });
      }
    });
  }

  async start(): Promise<void> {
    const receiver = (this.app as unknown as {
      receiver?: { client?: { on?: (event: string, fn: () => void) => void } };
    }).receiver;
    receiver?.client?.on?.("connected", () => { this.connected = true; });
    receiver?.client?.on?.("disconnected", () => { this.connected = false; });
    await this.app.start();
    this.connected = true;
    const auth = await this.app.client.auth.test();
    this.botId = (auth as { user_id?: string }).user_id;
  }

  async stop(): Promise<void> {
    await this.app.stop();
    this.connected = false;
  }

  isConnected(): boolean { return this.connected; }
  botUserId(): string | undefined { return this.botId; }

  async postMessage(msg: OutboundMessage): Promise<{ channel: string; ts: string }> {
    const res = await this.app.client.chat.postMessage({
      channel: msg.channel,
      text: msg.text,
      blocks: msg.blocks as never,
      thread_ts: msg.threadTs,
    });
    return { channel: (res.channel as string) ?? msg.channel, ts: (res.ts as string) ?? "" };
  }

  async updateMessage(msg: { channel: string; ts: string; text: string; blocks?: unknown[] }): Promise<void> {
    await this.app.client.chat.update({
      channel: msg.channel,
      ts: msg.ts,
      text: msg.text,
      blocks: (msg.blocks ?? []) as never,
    });
  }

  async postEphemeral(msg: { channel: string; user: string; text: string }): Promise<void> {
    await this.app.client.chat.postEphemeral({ channel: msg.channel, user: msg.user, text: msg.text });
  }

  async openDm(userId: string): Promise<string> {
    const res = await this.app.client.conversations.open({ users: userId });
    return (res.channel as { id?: string })?.id ?? userId;
  }

  async getUserDisplayName(userId: string): Promise<string> {
    try {
      const res = await this.app.client.users.info({ user: userId });
      const user = res.user as
        | { profile?: { display_name?: string; real_name?: string }; real_name?: string }
        | undefined;
      return user?.profile?.display_name || user?.profile?.real_name || user?.real_name || userId;
    } catch {
      return userId;
    }
  }
}
```

- [ ] **Step 4: Write `src/worker.ts`**

```ts
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

  onHealth() {
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
    if (!lastCtx || errors.length > 0) return { ok: errors.length === 0, errors };

    const { WebClient } = await import("@slack/web-api");
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
```

- [ ] **Step 5: Run tests and typecheck**

Run: `npx vitest run tests/worker.test.ts && npm run typecheck`
Expected: 4 passed; typecheck exit 0. (Importing `worker.ts` in tests is safe: `runWorker`'s main-module check only starts the RPC host when the file is executed directly.)

- [ ] **Step 6: Run the full suite**

Run: `npm test`
Expected: all files pass (helpers 3, formatters 7, chat 7, notifications 5, approvals 4, ask-human 7, commands 4, cleanup 3, manifest 4, worker 4).

- [ ] **Step 7: Commit**

```bash
git add src/bolt-gateway.ts src/worker.ts tests/worker.test.ts
git commit -m "feat: Bolt Socket Mode gateway and worker lifecycle wiring"
```

---

### Task 11: Slack app manifest, README, final verification

**Files:**
- Create: `slack-app-manifest.json`, `README.md`

**Interfaces:**
- Consumes: everything; documents the setup flow end-to-end.
- Produces: operator-facing setup assets. No code.

- [ ] **Step 1: Write `slack-app-manifest.json`**

```json
{
  "display_information": {
    "name": "Paperclip",
    "description": "Chat with your Paperclip agents from Slack",
    "background_color": "#1f2430"
  },
  "features": {
    "bot_user": {
      "display_name": "paperclip",
      "always_online": true
    },
    "slash_commands": [
      {
        "command": "/paperclip",
        "description": "Paperclip commands",
        "usage_hint": "issue <title> | help",
        "should_escape": false
      }
    ]
  },
  "oauth_config": {
    "scopes": {
      "bot": [
        "app_mentions:read",
        "chat:write",
        "channels:history",
        "groups:history",
        "im:history",
        "im:read",
        "im:write",
        "reactions:read",
        "users:read",
        "commands"
      ]
    }
  },
  "settings": {
    "event_subscriptions": {
      "bot_events": [
        "app_mention",
        "message.channels",
        "message.groups",
        "message.im",
        "reaction_added"
      ]
    },
    "interactivity": {
      "is_enabled": true
    },
    "org_deploy_enabled": false,
    "socket_mode_enabled": true,
    "token_rotation_enabled": false
  }
}
```

- [ ] **Step 2: Write `README.md`**

Content requirements (write full prose, not placeholders):
- **What it is:** one-paragraph summary (Socket Mode, no public URL, feature list: agent chat in DMs/mentions/threads, notifications with toggles, approvals with buttons, `ask_human` tool, `/paperclip issue`).
- **Slack setup:** create app at api.slack.com/apps → "From an app manifest" → paste `slack-app-manifest.json` → Install to Workspace → copy Bot User OAuth Token (`xoxb-…`) → Basic Information → App-Level Tokens → create token with `connections:write` scope (`xapp-…`).
- **Paperclip setup:** create two secrets (bot token, app token) in Settings → Secrets; install the plugin (npm package `paperclip-plugin-slack-socket`); paste the two secret UUIDs plus `companyId`, `defaultAgentId`, `defaultChannelId` into plugin settings; press Test Connection (runs `auth.test` + `apps.connections.open`).
- **Usage:** DM the bot from the Apps sidebar; `/invite @paperclip` to a channel then @mention it; thread replies continue the same agent session; `/paperclip issue <title>`; agents can call `ask_human`.
- **Manual smoke test checklist:** (1) health shows OK after configuring; (2) DM "hello" → streamed agent reply in thread; (3) @mention in a channel → reply; (4) thread reply continues the session without re-mentioning; (5) create an issue in Paperclip → Slack notification appears; (6) create an approval → buttons appear, clicking Approve updates the message inline; (7) have an agent call `ask_human` with mode `reaction` → react → comment lands on the issue; (8) `/paperclip issue Test` → ephemeral link.
- **Security notes:** Socket Mode = zero inbound HTTP surface; tokens only in Paperclip secrets; any workspace member who can DM the bot can talk to the default agent (allowlists are future work).

- [ ] **Step 3: Full verification**

Run: `npm test && npm run build`
Expected: all tests pass; `dist/` contains `worker.js`, `manifest.js`, `index.js` (plus the other modules and `.d.ts` files).

- [ ] **Step 4: Commit**

```bash
git add slack-app-manifest.json README.md
git commit -m "docs: Slack app manifest and setup guide"
```

---

## Plan Self-Review (completed)

- **Spec coverage:** chat per-thread sessions + streaming (Task 4), notifications with toggles/overrides (Task 5), approvals with buttons via `ctx.approvals.decide` (Task 6), `ask_human` reaction/answer → issue comment + wakeup (Task 7), `/paperclip issue` + cleanup TTLs (Task 8), manifest with zero webhooks and least-privilege capabilities + config schema + Test Connection (Tasks 9–10), lifecycle/health/secret handling (Task 10), Slack app manifest + README + smoke test (Task 11). Identity mapping intentionally absent (spec: out of scope).
- **Type consistency:** `SlackGateway` and module factory signatures are defined once in Task 1 and consumed verbatim in Tasks 2–10; `FakeGateway` mirrors the interface exactly.
- **Known judgment calls:** Bolt/web-api version floors (`^4.2.0`, `^7.8.0`) and the SDK dev version (`^2026.618.0`) mirror the reference plugin's era — if `npm install` reports different latest majors, keep the majors pinned here unless compilation fails. The `receiver.client` connected/disconnected listeners in `BoltGateway.start()` are defensively optional-chained; if the receiver shape differs at runtime, health falls back to "connected after start()" which is still safe.
