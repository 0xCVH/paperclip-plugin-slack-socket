# `slack_post_message` Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a second agent tool, `slack_post_message`, letting a Paperclip agent post to operator-allowlisted Slack channels or DM allowlisted users.

**Architecture:** A pure authorization function in `access.ts` decides whether a target is postable; a handler module `post-message.ts` (shaped exactly like the existing `ask-human.ts`) validates params, consults that decision, escapes and converts the text, and posts through the existing `SlackGateway`. Six new instance-config fields gate the whole thing, all defaulting off. The tool registers alongside `ask_human` in `ensureCoreModules`.

**Tech Stack:** TypeScript (ESM, NodeNext), `@paperclipai/plugin-sdk` 2026.722.0, `@slack/bolt`, vitest.

**Spec:** `docs/superpowers/specs/2026-08-01-slack-post-message-design.md`

## Global Constraints

- Every `.js` import specifier must carry the `.js` extension — the project builds ESM with `tsc` and NodeNext resolution.
- `npm test` (vitest) and `npm run typecheck` (`tsc --noEmit` plus `tsc -p tsconfig.test.json`) must both pass before any commit.
- Config defaults live in exactly one place: `DEFAULT_CONFIG` in `src/constants.ts`. `manifest.ts` property defaults reference `DEFAULT_CONFIG.<field>`, never a literal.
- New config fields default to their **safe** value: all booleans `false`, all lists `[]`.
- The two new allowlists fail **closed** on empty (empty = nothing authorized), the opposite of the existing `allowedSlackUserIds` (empty = disabled = everyone allowed). This inversion must be commented where the fields are defined and pinned by a test.
- Tool handlers never throw: every failure path returns `{ error: string }`.
- Refusal reasons may name a setting and echo the agent's own `target`, never a config value, secret, or resolved token.
- Plugin version becomes `0.8.0` in both `package.json` and `PLUGIN_VERSION` in `src/constants.ts` (Task 6). Commit subjects follow the repo convention: `feat: … (v0.8.0)` on the release commit.

---

### Task 1: Config surface

Adds the six fields to the type, the defaults, and the manifest's `instanceConfigSchema`, so an operator can save them and the host accepts the config.

**Files:**
- Modify: `src/types.ts` (the `SlackSocketConfig` interface)
- Modify: `src/constants.ts` (`DEFAULT_CONFIG`)
- Modify: `src/manifest.ts` (`instanceConfigSchema.properties`)
- Test: `tests/manifest-config-schema.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `SlackSocketConfig.agentPostMessageEnabled: boolean`, `.agentPostToChannelsEnabled: boolean`, `.agentPostChannelIds: string[]`, `.agentDmEnabled: boolean`, `.agentDmUserIds: string[]`, `.agentDmAnyUser: boolean`. Tasks 2 and 4 read these.

- [ ] **Step 1: Write the failing test**

Add to `tests/manifest-config-schema.test.ts`, inside the existing `describe("instanceConfigSchema vs the host settings form")` block:

```ts
  it("accepts the agent-posting fields the settings form stores", () => {
    const result = validateInstanceConfig({
      ...baseConfig,
      slackBotTokenRef: SECRET_REF,
      slackAppTokenRef: SECRET_REF,
      agentPostMessageEnabled: true,
      agentPostToChannelsEnabled: true,
      agentPostChannelIds: ["C01ABC2DEF3", "C09XYZ8GHI7"],
      agentDmEnabled: true,
      agentDmUserIds: ["U01ABC2DEF3"],
      agentDmAnyUser: false,
    });
    expect(result.errors).toEqual([]);
    expect(result.valid).toBe(true);
  });

  it("rejects a non-array agentPostChannelIds", () => {
    const result = validateInstanceConfig({
      ...baseConfig,
      slackBotTokenRef: SECRET_REF,
      slackAppTokenRef: SECRET_REF,
      agentPostChannelIds: "C01ABC2DEF3",
    });
    expect(result.valid).toBe(false);
  });

  it("defaults every agent-posting field to its safe value", () => {
    const schema = manifest.instanceConfigSchema as {
      properties: Record<string, { default?: unknown }>;
    };
    expect(schema.properties.agentPostMessageEnabled?.default).toBe(false);
    expect(schema.properties.agentPostToChannelsEnabled?.default).toBe(false);
    expect(schema.properties.agentPostChannelIds?.default).toEqual([]);
    expect(schema.properties.agentDmEnabled?.default).toBe(false);
    expect(schema.properties.agentDmUserIds?.default).toEqual([]);
    expect(schema.properties.agentDmAnyUser?.default).toBe(false);
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/manifest-config-schema.test.ts`
Expected: FAIL — the two default assertions get `undefined`, and the non-array case is `valid: true` because the schema doesn't know the property yet.

- [ ] **Step 3: Add the fields to `SlackSocketConfig`**

In `src/types.ts`, append to the `SlackSocketConfig` interface, after `allowedSlackUserIds`:

```ts
  // --- Agent-initiated posting (the slack_post_message tool) ---------
  //
  // NOTE the inverted emptiness semantics versus `allowedSlackUserIds`
  // above: that list is an INBOUND gate where empty means "no restriction
  // configured, everyone may drive the bot". These two lists are OUTBOUND
  // capability grants where empty means "nothing authorized". An outbound
  // capability that defaulted to "no restriction" would ship the plugin
  // able to post into every channel its bot can reach.
  agentPostMessageEnabled: boolean;
  agentPostToChannelsEnabled: boolean;
  agentPostChannelIds: string[];
  agentDmEnabled: boolean;
  agentDmUserIds: string[];
  agentDmAnyUser: boolean;
```

- [ ] **Step 4: Add the defaults**

In `src/constants.ts`, append to `DEFAULT_CONFIG`, after `allowedSlackUserIds: []`:

```ts
  agentPostMessageEnabled: false,
  agentPostToChannelsEnabled: false,
  agentPostChannelIds: [],
  agentDmEnabled: false,
  agentDmUserIds: [],
  agentDmAnyUser: false,
```

- [ ] **Step 5: Add the manifest properties**

In `src/manifest.ts`, append to `instanceConfigSchema.properties`, after the `allowedSlackUserIds` property. Do **not** add any of these to `required`:

```ts
      agentPostMessageEnabled: {
        type: "boolean",
        title: "Let agents post to Slack",
        description:
          "Master switch for the slack_post_message tool. When off (the default), agents cannot post to Slack at all and every call is refused, regardless of the settings below.",
        default: DEFAULT_CONFIG.agentPostMessageEnabled,
      },
      agentPostToChannelsEnabled: {
        type: "boolean",
        title: "Allow agent posts to channels",
        description:
          "Allows agents to post to the channels listed below. Turn this off to suspend channel posting without clearing the list.",
        default: DEFAULT_CONFIG.agentPostToChannelsEnabled,
      },
      agentPostChannelIds: {
        type: "array",
        items: { type: "string" },
        title: "Agent-postable channel IDs",
        description:
          "Channel IDs (e.g. C01ABC2DEF3) that agents may post to. Empty means no channel may be posted to — unlike the inbound allowlist above, an empty list here authorizes nothing rather than removing the restriction. The bot must also be a member of the channel.",
        default: DEFAULT_CONFIG.agentPostChannelIds,
      },
      agentDmEnabled: {
        type: "boolean",
        title: "Allow agent DMs",
        description:
          "Allows agents to send direct messages. Turn this off to suspend DMs without clearing the list below.",
        default: DEFAULT_CONFIG.agentDmEnabled,
      },
      agentDmUserIds: {
        type: "array",
        items: { type: "string" },
        title: "Agent-DM-able user IDs",
        description:
          "Slack user IDs (e.g. U01ABC2DEF3) that agents may DM. Empty means no user may be DM'd. Ignored when \"Allow agent DMs to anyone\" is on.",
        default: DEFAULT_CONFIG.agentDmUserIds,
      },
      agentDmAnyUser: {
        type: "boolean",
        title: "Allow agent DMs to anyone",
        description:
          "When on, agents may DM any member of the workspace and the user list above is ignored. Still requires \"Allow agent DMs\" to be on.",
        default: DEFAULT_CONFIG.agentDmAnyUser,
      },
```

- [ ] **Step 6: Run the tests and typecheck**

Run: `npx vitest run tests/manifest-config-schema.test.ts && npm run typecheck`
Expected: PASS. The typecheck matters here — `DEFAULT_CONFIG` is typed `SlackSocketConfig`, so a field added to one and not the other fails to compile.

- [ ] **Step 7: Run the whole suite**

Run: `npm test`
Expected: PASS — `TEST_CONFIG` in `tests/helpers.ts` spreads `DEFAULT_CONFIG`, so it picks up the new fields with no change.

- [ ] **Step 8: Commit**

```bash
git add src/types.ts src/constants.ts src/manifest.ts tests/manifest-config-schema.test.ts
git commit -m "feat: instance config for agent-initiated Slack posting"
```

---

### Task 2: `checkPostTarget` authorization

The whole authorization matrix as one pure function, unit-testable with no gateway and no plugin context — the same reason `isUserAllowed` lives in this file.

**Files:**
- Modify: `src/access.ts`
- Test: `tests/access.test.ts`

**Interfaces:**
- Consumes: `SlackSocketConfig` fields from Task 1.
- Produces: `checkPostTarget(config: SlackSocketConfig, target: string): PostTargetDecision`, where `PostTargetDecision` is `{ allowed: true; kind: "channel" | "dm"; target: string } | { allowed: false; reason: string }`. Task 4 calls it. On `allowed: true`, `target` is the **trimmed** input, original case preserved (Slack IDs are case-sensitive on the wire; matching is case-insensitive only to forgive operator typos in config).

- [ ] **Step 1: Write the failing test**

Append to `tests/access.test.ts`. Note the import line at the top of the file must become
`import { checkPostTarget, isUserAllowed } from "../src/access.js";`
plus `import { DEFAULT_CONFIG } from "../src/constants.js";`:

```ts
const postConfig = (overrides: Partial<SlackSocketConfig> = {}): SlackSocketConfig => ({
  ...DEFAULT_CONFIG,
  agentPostMessageEnabled: true,
  agentPostToChannelsEnabled: true,
  agentPostChannelIds: ["C-OK"],
  agentDmEnabled: true,
  agentDmUserIds: ["U-OK"],
  ...overrides,
});

describe("checkPostTarget", () => {
  it("refuses everything when the master switch is off", () => {
    const cfg = postConfig({ agentPostMessageEnabled: false });
    expect(checkPostTarget(cfg, "C-OK").allowed).toBe(false);
    expect(checkPostTarget(cfg, "U-OK").allowed).toBe(false);
  });

  it("allows a listed channel", () => {
    expect(checkPostTarget(postConfig(), "C-OK")).toEqual({
      allowed: true, kind: "channel", target: "C-OK",
    });
  });

  it("refuses an unlisted channel", () => {
    const decision = checkPostTarget(postConfig(), "C-OTHER");
    expect(decision.allowed).toBe(false);
    expect(decision.allowed === false && decision.reason).toContain("agentPostChannelIds");
  });

  it("refuses every channel when the list is empty", () => {
    expect(checkPostTarget(postConfig({ agentPostChannelIds: [] }), "C-OK").allowed).toBe(false);
  });

  it("refuses every channel when the list holds only blank entries", () => {
    expect(checkPostTarget(postConfig({ agentPostChannelIds: ["", "  "] }), "C-OK").allowed).toBe(false);
  });

  it("refuses channels when channel posting is switched off", () => {
    expect(checkPostTarget(postConfig({ agentPostToChannelsEnabled: false }), "C-OK").allowed).toBe(false);
  });

  it("allows a listed user as a dm", () => {
    expect(checkPostTarget(postConfig(), "U-OK")).toEqual({
      allowed: true, kind: "dm", target: "U-OK",
    });
  });

  it("treats an Enterprise Grid W-prefixed id as a dm", () => {
    expect(checkPostTarget(postConfig({ agentDmUserIds: ["W-OK"] }), "W-OK")).toEqual({
      allowed: true, kind: "dm", target: "W-OK",
    });
  });

  it("refuses an unlisted user", () => {
    const decision = checkPostTarget(postConfig(), "U-OTHER");
    expect(decision.allowed).toBe(false);
    expect(decision.allowed === false && decision.reason).toContain("agentDmUserIds");
  });

  it("refuses every dm when the list is empty", () => {
    expect(checkPostTarget(postConfig({ agentDmUserIds: [] }), "U-OK").allowed).toBe(false);
  });

  it("refuses dms when dm sending is switched off", () => {
    expect(checkPostTarget(postConfig({ agentDmEnabled: false }), "U-OK").allowed).toBe(false);
  });

  it("allows any user when agentDmAnyUser is on", () => {
    const cfg = postConfig({ agentDmUserIds: [], agentDmAnyUser: true });
    expect(checkPostTarget(cfg, "U-STRANGER")).toEqual({
      allowed: true, kind: "dm", target: "U-STRANGER",
    });
  });

  it("still refuses dms when agentDmAnyUser is on but dm sending is off", () => {
    const cfg = postConfig({ agentDmAnyUser: true, agentDmEnabled: false });
    expect(checkPostTarget(cfg, "U-STRANGER").allowed).toBe(false);
  });

  it("matches trimmed and case-insensitively, and returns the trimmed target", () => {
    const cfg = postConfig({ agentPostChannelIds: ["  c-ok  "] });
    expect(checkPostTarget(cfg, "  C-OK  ")).toEqual({
      allowed: true, kind: "channel", target: "C-OK",
    });
  });

  it("refuses a blank target", () => {
    expect(checkPostTarget(postConfig(), "   ").allowed).toBe(false);
  });

  it("never authorizes a user id listed in the channel list", () => {
    const cfg = postConfig({ agentPostChannelIds: ["U-OK"], agentDmUserIds: [] });
    expect(checkPostTarget(cfg, "U-OK").allowed).toBe(false);
  });
});
```

Also add `import type { SlackSocketConfig } from "../src/types.js";` to the test file's imports.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/access.test.ts`
Expected: FAIL — `checkPostTarget` is not exported from `../src/access.js`.

- [ ] **Step 3: Implement `checkPostTarget`**

In `src/access.ts`, add the import at the top:

```ts
import type { SlackSocketConfig } from "./types.js";
```

Extract the normalization `isUserAllowed` already performs into a shared helper, and rewrite `isUserAllowed`'s body to use it (its behavior is unchanged — including empty-means-allowed):

```ts
/** Trim + lowercase every entry and drop the blanks. */
function normalizeList(list: readonly string[]): string[] {
  return list.map((id) => id.trim().toLowerCase()).filter((id) => id.length > 0);
}
```

`isUserAllowed`'s first line becomes `const normalized = normalizeList(allowlist);` — the rest of the function is untouched.

Then append:

```ts
/**
 * Decision returned by `checkPostTarget`. On `allowed: true`, `target` is the
 * trimmed input with its original case preserved: Slack IDs are case-sensitive
 * on the wire, and matching is case-insensitive only to forgive operator typos
 * in the config lists.
 */
export type PostTargetDecision =
  | { allowed: true; kind: "channel" | "dm"; target: string }
  | { allowed: false; reason: string };

// A leading "U" is a regular user id; Enterprise Grid's cross-workspace
// "connected" users get a "W" instead. Both are DM targets. Anything else
// (C…, G…) is treated as a channel — the same prefix dispatch ask_human's
// `target` param uses.
const DM_PREFIXES = ["u", "w"];

/**
 * Decides whether `target` may be posted to by the slack_post_message tool.
 *
 * The prefix alone selects the path, so a `U…` id sitting in
 * `agentPostChannelIds` authorizes nothing — the DM path never consults that
 * list. That misconfiguration is pinned by a test rather than silently
 * papered over.
 *
 * Both lists fail CLOSED when empty: empty means "nothing authorized", the
 * opposite of `isUserAllowed` above, where empty means "no restriction
 * configured". See the note on these fields in types.ts for why an outbound
 * capability must not default to unrestricted.
 *
 * `reason` is returned to the calling agent verbatim, so it names the setting
 * that refused and echoes the agent's own target — never a config value.
 */
export function checkPostTarget(config: SlackSocketConfig, target: string): PostTargetDecision {
  if (!config.agentPostMessageEnabled) {
    return { allowed: false, reason: "Posting to Slack is disabled for agents (agentPostMessageEnabled is off)." };
  }

  const trimmed = target.trim();
  if (trimmed.length === 0) return { allowed: false, reason: "target is required." };

  if (DM_PREFIXES.includes(trimmed[0]!.toLowerCase())) {
    if (!config.agentDmEnabled) {
      return { allowed: false, reason: "Sending DMs is disabled for agents (agentDmEnabled is off)." };
    }
    if (!config.agentDmAnyUser && !normalizeList(config.agentDmUserIds).includes(trimmed.toLowerCase())) {
      return { allowed: false, reason: `User "${trimmed}" is not in agentDmUserIds.` };
    }
    return { allowed: true, kind: "dm", target: trimmed };
  }

  if (!config.agentPostToChannelsEnabled) {
    return { allowed: false, reason: "Posting to channels is disabled for agents (agentPostToChannelsEnabled is off)." };
  }
  if (!normalizeList(config.agentPostChannelIds).includes(trimmed.toLowerCase())) {
    return { allowed: false, reason: `Channel "${trimmed}" is not in agentPostChannelIds.` };
  }
  return { allowed: true, kind: "channel", target: trimmed };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/access.test.ts && npm run typecheck`
Expected: PASS, including the pre-existing `isUserAllowed` tests — the refactor must not change its behavior.

- [ ] **Step 5: Commit**

```bash
git add src/access.ts tests/access.test.ts
git commit -m "feat: checkPostTarget authorization for agent Slack posting"
```

---

### Task 3: Shared message-splitting helpers

`post-message.ts` needs the same 3900-character split `chat.ts` uses. Move it rather than copy it.

**Files:**
- Create: `src/slack-text.ts`
- Modify: `src/chat.ts:31-40` (delete the local definitions, import them instead)
- Test: `tests/chat.test.ts` (existing, must stay green — no new test; the behavior is unchanged and Task 4 covers the new call site)

**Interfaces:**
- Consumes: nothing.
- Produces: `MAX_MESSAGE_LENGTH: 3900` and `splitIntoChunks(text: string, size: number): string[]` from `src/slack-text.js`. Task 4 imports both.

- [ ] **Step 1: Create the shared module**

Create `src/slack-text.ts`:

```ts
// Text helpers shared by every path that posts agent-authored text to Slack
// (chat replies and the slack_post_message tool).

// Slack's chat.postMessage/chat.update reject payloads with roughly
// >4000-character text. Stay comfortably under that for both the rolling
// streamed update and each chunk of an overlong message.
export const MAX_MESSAGE_LENGTH = 3900;

/** Splits `text` into `size`-character chunks. Returns [] for empty input. */
export function splitIntoChunks(text: string, size: number): string[] {
  const chunks: string[] = [];
  for (let i = 0; i < text.length; i += size) chunks.push(text.slice(i, i + size));
  return chunks;
}
```

- [ ] **Step 2: Point `chat.ts` at it**

In `src/chat.ts`, delete the `MAX_MESSAGE_LENGTH` const (and its comment) and the whole `splitIntoChunks` function — lines 28-40. Keep `truncateForStreaming` exactly as it is. Add to the imports at the top:

```ts
import { MAX_MESSAGE_LENGTH, splitIntoChunks } from "./slack-text.js";
```

- [ ] **Step 3: Run the tests and typecheck**

Run: `npm test && npm run typecheck`
Expected: PASS with no test changes — this is a pure move.

- [ ] **Step 4: Commit**

```bash
git add src/slack-text.ts src/chat.ts
git commit -m "refactor: share Slack message-splitting helpers"
```

---

### Task 4: The `slack_post_message` tool

**Files:**
- Create: `src/post-message.ts`
- Modify: `src/constants.ts` (`TOOL_NAMES`, new `POST_MESSAGE_TOOL_DECLARATION`)
- Modify: `src/manifest.ts:175` (the `tools` array)
- Modify: `src/worker.ts:30-35` (`CoreModules`), `src/worker.ts:186-198` (`ensureCoreModules`)
- Test: `tests/post-message.test.ts` (create), `tests/manifest.test.ts:23-26`, `tests/worker.test.ts:145`

**Interfaces:**
- Consumes: `checkPostTarget` / `PostTargetDecision` (Task 2), `MAX_MESSAGE_LENGTH` / `splitIntoChunks` (Task 3), the config fields (Task 1), and the existing `escapeMrkdwn` from `src/formatters.js`, `markdownToMrkdwn` from `src/mrkdwn.js`, `errString` from `src/redact.js`.
- Produces: `createPostMessage(deps: PostMessageDeps): PostMessage` where `PostMessageDeps` is `{ ctx: PluginContext; gateway: SlackGateway; getConfig: () => Promise<SlackSocketConfig> }` and `PostMessage` is `{ registerTool(): void }`. Also `TOOL_NAMES.postMessage === "slack_post_message"`.

- [ ] **Step 1: Write the failing test**

Create `tests/post-message.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { createPostMessage } from "../src/post-message.js";
import { DEFAULT_CONFIG, TOOL_NAMES } from "../src/constants.js";
import type { SlackSocketConfig } from "../src/types.js";
import { FakeGateway, makeCtx } from "./helpers.js";

const RUN_CTX = { agentId: "agent-1", runId: "run-1", companyId: "co-1", projectId: "proj-1" };

type Handler = (params: unknown, runCtx: typeof RUN_CTX) => Promise<{
  content?: string; error?: string; data?: { channel: string; ts: string };
}>;

function setup(overrides: Partial<SlackSocketConfig> = {}) {
  const bundle = makeCtx();
  const gateway = new FakeGateway();
  const config: SlackSocketConfig = {
    ...DEFAULT_CONFIG,
    companyId: "co-1",
    agentPostMessageEnabled: true,
    agentPostToChannelsEnabled: true,
    agentPostChannelIds: ["C-OK"],
    agentDmEnabled: true,
    agentDmUserIds: ["U-OK"],
    ...overrides,
  };
  const postMessage = createPostMessage({ ctx: bundle.ctx, gateway, getConfig: async () => config });
  postMessage.registerTool();
  const call = (bundle.ctx.tools.register as any).mock.calls[0];
  return { ...bundle, gateway, toolName: call[0] as string, handler: call[2] as Handler };
}

describe("slack_post_message tool", () => {
  it("registers under the slack_post_message name and posts to an allowlisted channel", async () => {
    const { toolName, handler, gateway } = setup();
    expect(toolName).toBe(TOOL_NAMES.postMessage);
    const result = await handler({ target: "C-OK", text: "ship it" }, RUN_CTX);
    expect(result.error).toBeUndefined();
    expect(gateway.posts).toHaveLength(1);
    expect(gateway.posts[0]).toMatchObject({ channel: "C-OK", text: "ship it" });
    expect(result.data).toEqual({ channel: "C-OK", ts: gateway.posts[0]!.ts });
  });

  it("opens a DM and posts there when the target is an allowlisted user", async () => {
    const { handler, gateway } = setup();
    const result = await handler({ target: "U-OK", text: "hi" }, RUN_CTX);
    expect(gateway.dmOpens).toEqual(["U-OK"]);
    expect(gateway.posts[0]!.channel).toBe("D-U-OK");
    expect(result.data?.channel).toBe("D-U-OK");
  });

  it("refuses a target that is not allowlisted, without posting or opening a DM", async () => {
    const { handler, gateway } = setup();
    const result = await handler({ target: "C-SECRET", text: "leak" }, RUN_CTX);
    expect(result.error).toContain("agentPostChannelIds");
    expect(gateway.posts).toHaveLength(0);
    expect(gateway.dmOpens).toHaveLength(0);
  });

  it("refuses everything when the master switch is off", async () => {
    const { handler, gateway } = setup({ agentPostMessageEnabled: false });
    const result = await handler({ target: "C-OK", text: "hi" }, RUN_CTX);
    expect(result.error).toContain("agentPostMessageEnabled");
    expect(gateway.posts).toHaveLength(0);
  });

  it("rejects missing params without posting", async () => {
    const { handler, gateway } = setup();
    expect((await handler({ target: "C-OK" }, RUN_CTX)).error).toBeTruthy();
    expect((await handler({ text: "hi" }, RUN_CTX)).error).toBeTruthy();
    expect((await handler({ target: "C-OK", text: "   " }, RUN_CTX)).error).toBeTruthy();
    expect(gateway.posts).toHaveLength(0);
  });

  it("escapes Slack control sequences so an agent cannot ping the channel", async () => {
    const { handler, gateway } = setup();
    await handler({ target: "C-OK", text: "hey <!channel> look" }, RUN_CTX);
    expect(gateway.posts[0]!.text).toBe("hey &lt;!channel&gt; look");
  });

  it("escapes a hand-authored link so its destination cannot be disguised", async () => {
    const { handler, gateway } = setup();
    await handler({ target: "C-OK", text: "<https://evil.example|Payroll>" }, RUN_CTX);
    expect(gateway.posts[0]!.text).not.toContain("<https://evil.example|");
  });

  it("still converts the agent's own Markdown link into Slack link syntax", async () => {
    const { handler, gateway } = setup();
    await handler({ target: "C-OK", text: "see [the docs](https://ok.example)" }, RUN_CTX);
    expect(gateway.posts[0]!.text).toBe("see <https://ok.example|the docs>");
  });

  it("converts Markdown bold to mrkdwn", async () => {
    const { handler, gateway } = setup();
    await handler({ target: "C-OK", text: "**done**" }, RUN_CTX);
    expect(gateway.posts[0]!.text).toBe("*done*");
  });

  it("passes threadTs through", async () => {
    const { handler, gateway } = setup();
    await handler({ target: "C-OK", text: "hi", threadTs: "1700.5" }, RUN_CTX);
    expect(gateway.posts[0]!.threadTs).toBe("1700.5");
  });

  it("splits an overlong message and threads the remainder under the first post", async () => {
    const { handler, gateway } = setup();
    await handler({ target: "C-OK", text: "a".repeat(4200) }, RUN_CTX);
    expect(gateway.posts).toHaveLength(2);
    expect(gateway.posts[0]!.text).toHaveLength(3900);
    expect(gateway.posts[1]!.text).toHaveLength(300);
    expect(gateway.posts[1]!.threadTs).toBe(gateway.posts[0]!.ts);
  });

  it("returns an error instead of throwing when Slack fails", async () => {
    const { handler, gateway } = setup();
    gateway.postMessage = async () => { throw new Error("channel_not_found"); };
    const result = await handler({ target: "C-OK", text: "hi" }, RUN_CTX);
    expect(result.error).toContain("channel_not_found");
  });

  it("writes a metric on both the posted and refused paths", async () => {
    const { handler, ctx } = setup();
    await handler({ target: "C-OK", text: "hi" }, RUN_CTX);
    await handler({ target: "C-NOPE", text: "hi" }, RUN_CTX);
    const names = (ctx.metrics.write as any).mock.calls.map((c: unknown[]) => c[0]);
    expect(names).toContain("slack.messages.posted");
    expect(names).toContain("slack.messages.refused");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/post-message.test.ts`
Expected: FAIL — cannot resolve `../src/post-message.js`.

- [ ] **Step 3: Add the tool name and declaration**

In `src/constants.ts`, extend `TOOL_NAMES`:

```ts
export const TOOL_NAMES = {
  askHuman: "ask_human",
  postMessage: "slack_post_message",
} as const;
```

and add, directly after `ASK_HUMAN_TOOL_DECLARATION`:

```ts
export const POST_MESSAGE_TOOL_DECLARATION: PluginToolDeclaration = {
  name: TOOL_NAMES.postMessage,
  displayName: "Post a Slack message",
  description:
    "Post a message to a Slack channel, or DM a Slack user. Only the channels and users the operator has allowlisted in this plugin's settings can be targeted — any other target is refused. One-way: replies are not routed back to you, so use ask_human when you need an answer.",
  parametersSchema: {
    type: "object",
    properties: {
      target: {
        type: "string",
        description: "Slack channel ID (C…/G…) to post in, or Slack user ID (U…/W…) to DM.",
      },
      text: { type: "string", description: "Message body, in Markdown." },
      threadTs: {
        type: "string",
        description: "Optional ts of an existing message; posts this message as a reply beneath it.",
      },
    },
    required: ["target", "text"],
  },
};
```

- [ ] **Step 4: Write the handler**

Create `src/post-message.ts`:

```ts
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
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run tests/post-message.test.ts && npm run typecheck`
Expected: PASS.

- [ ] **Step 6: Declare the tool in the manifest**

In `src/manifest.ts`, add the import:

```ts
import {
  ASK_HUMAN_TOOL_DECLARATION,
  DEFAULT_CONFIG,
  JOB_KEYS,
  PLUGIN_ID,
  PLUGIN_VERSION,
  POST_MESSAGE_TOOL_DECLARATION,
} from "./constants.js";
```

and change line 175 to:

```ts
  tools: [ASK_HUMAN_TOOL_DECLARATION, POST_MESSAGE_TOOL_DECLARATION],
```

Update the existing assertion in `tests/manifest.test.ts` (currently lines 23-26) to:

```ts
  it("declares the cleanup job and both agent tools", () => {
    expect(manifest.jobs?.map((j) => j.jobKey)).toEqual([JOB_KEYS.cleanup]);
    expect(manifest.tools?.map((t) => t.name)).toEqual([TOOL_NAMES.askHuman, TOOL_NAMES.postMessage]);
  });
```

- [ ] **Step 7: Wire it into the worker**

In `src/worker.ts`, add the import:

```ts
import { createPostMessage, type PostMessage } from "./post-message.js";
```

Extend the `CoreModules` interface (line ~30) with `postMessage: PostMessage;`, and in `ensureCoreModules` (line ~186) register it beside `ask_human`:

```ts
  const chat = createChat({ ctx, gateway: gatewayProxy, getConfig });
  const askHuman = createAskHuman({ ctx, gateway: gatewayProxy });
  const commands = createCommands({ ctx, gateway: gatewayProxy, getConfig });
  // Both tools register here, from setup()'s clean context, against the
  // gateway proxy — the real gateway doesn't exist until a config arrives.
  // Registration therefore cannot be gated on config: slack_post_message
  // enforces its switches per call instead (see checkPostTarget).
  const postMessage = createPostMessage({ ctx, gateway: gatewayProxy, getConfig });
  askHuman.registerTool();
  postMessage.registerTool();

  coreModules = { chat, askHuman, commands, postMessage, gatewayProxy };
```

Update the registration assertion in `tests/worker.test.ts` (currently line 145) to:

```ts
    expect((ctx.tools.register as any).mock.calls.map((c: unknown[]) => c[0])).toEqual([
      TOOL_NAMES.askHuman,
      TOOL_NAMES.postMessage,
    ]);
```

- [ ] **Step 8: Run the whole suite and typecheck**

Run: `npm test && npm run typecheck`
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add src/post-message.ts src/constants.ts src/manifest.ts src/worker.ts \
        tests/post-message.test.ts tests/manifest.test.ts tests/worker.test.ts
git commit -m "feat: slack_post_message tool restricted to allowlisted channels and DMs"
```

---

### Task 5: Escape agent replies in chat too

`chat.ts` converts agent replies to mrkdwn but never escapes them, so an agent replying in an ordinary Slack conversation can already emit `<!channel>` and ping everyone. Same ordering fix, separate commit — it is a pre-existing gap, not part of the new tool.

**Files:**
- Modify: `src/chat.ts:213` and `src/chat.ts:246`
- Test: `tests/chat.test.ts`

**Interfaces:**
- Consumes: `escapeMrkdwn` from `src/formatters.js`.
- Produces: nothing new.

- [ ] **Step 1: Write the failing test**

Add to `tests/chat.test.ts`, inside the existing top-level `describe("chat")` block. This uses the same `setup()` / `dm()` helpers and the same `mockImplementationOnce` shape as the neighbouring "splits a long final reply" test:

```ts
  it("escapes Slack control sequences in an agent's final reply", async () => {
    const { ctx, gateway, chat } = setup();
    (ctx.agents.sessions.sendMessage as any).mockImplementationOnce(
      async (_sessionId: string, _companyId: string, opts: { onEvent?: (e: unknown) => void }) => {
        opts.onEvent?.({
          sessionId: "sess-1", runId: "run-1", seq: 1,
          eventType: "done", stream: null, message: "<!channel> ship it", payload: null,
        });
        return { runId: "run-1" };
      },
    );

    await chat.handleMessage(dm("hi", "810.1"));

    // An agent must not be able to mass-ping a channel through a chat turn.
    expect(gateway.updates.at(-1)!.text).toBe("&lt;!channel&gt; ship it");
  });

  it("still renders an agent's own Markdown link in a chat reply", async () => {
    const { ctx, gateway, chat } = setup();
    (ctx.agents.sessions.sendMessage as any).mockImplementationOnce(
      async (_sessionId: string, _companyId: string, opts: { onEvent?: (e: unknown) => void }) => {
        opts.onEvent?.({
          sessionId: "sess-1", runId: "run-1", seq: 1,
          eventType: "done", stream: null, message: "see [the docs](https://ok.example)", payload: null,
        });
        return { runId: "run-1" };
      },
    );

    await chat.handleMessage(dm("hi", "811.1"));

    expect(gateway.updates.at(-1)!.text).toBe("see <https://ok.example|the docs>");
  });
```

The second test is what pins the escape-then-convert *ordering*: escaping after conversion would leave `&lt;https://ok.example|the docs&gt;` and this assertion would fail.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/chat.test.ts`
Expected: FAIL — the text arrives as literal `<!channel> ship it`.

- [ ] **Step 3: Escape before converting, in both places**

In `src/chat.ts`, add `escapeMrkdwn` to the existing imports:

```ts
import { escapeMrkdwn } from "./formatters.js";
```

Line 213 (the streaming path) becomes:

```ts
        if (buffer) pushUpdate(markdownToMrkdwn(escapeMrkdwn(filterRuntimeNoticeLines(buffer))));
```

Line 246 (the final reply) becomes:

```ts
              finalizeMessage(
                markdownToMrkdwn(escapeMrkdwn(extractReply(e.message ?? (buffer || "_(no reply)_")))),
              );
```

Extend the existing comment above line 246 with:

```
              // Escape before converting: escaping the agent's raw text
              // removes its ability to emit Slack control sequences
              // (<!channel>, <!here>, disguised <url|text> links) directly,
              // while the conversion still produces real link syntax from
              // the agent's own [text](url) Markdown.
```

Note `_(no reply)_` passes through `escapeMrkdwn` unchanged — it contains none of `&`, `<`, `>`.

- [ ] **Step 4: Run the tests**

Run: `npm test && npm run typecheck`
Expected: PASS. If an existing chat test asserted on a reply containing `<`, `>`, or `&`, its expectation now needs the escaped form — that is a correct update, not a regression.

- [ ] **Step 5: Commit**

```bash
git add src/chat.ts tests/chat.test.ts
git commit -m "fix: escape agent replies before mrkdwn conversion in chat"
```

---

### Task 6: Documentation and release

**Files:**
- Modify: `README.md` (the "What it is" bullets, the Paperclip setup config list, the Usage section)
- Modify: `package.json` (`version`)
- Modify: `src/constants.ts` (`PLUGIN_VERSION`)

**Interfaces:**
- Consumes: everything above.
- Produces: version `0.8.0`.

- [ ] **Step 1: Bump the version in both places**

`package.json`: `"version": "0.8.0"`.
`src/constants.ts`: `export const PLUGIN_VERSION = "0.8.0";`

- [ ] **Step 2: Add a "What it is" bullet**

In `README.md`, after the existing **The `ask_human` tool** bullet:

```markdown
- **The `slack_post_message` tool** — agents can post a message to a Slack channel or DM a person, restricted to targets the operator has explicitly allowlisted. It ships off: posting requires turning on `agentPostMessageEnabled` plus the per-mode switch, and adding the channel or user to the matching list. Unlike the inbound `allowedSlackUserIds`, an empty list here authorizes nothing rather than removing the restriction. Message text is escaped before Markdown conversion, so an agent can't mass-ping with `<!channel>` or disguise a link's destination, while its own `[text](url)` Markdown still renders as a Slack link. The tool is one-way — replies aren't routed back to the agent; that's what `ask_human` is for.
```

- [ ] **Step 3: Document the settings**

In the Paperclip setup section, in the paragraph listing optional settings, after the `allowedSlackUserIds` bullet:

```markdown
   - **Agent posting** (`agentPostMessageEnabled`, `agentPostToChannelsEnabled`, `agentPostChannelIds`, `agentDmEnabled`, `agentDmUserIds`, `agentDmAnyUser` — all off/empty by default) — controls the `slack_post_message` tool. `agentPostMessageEnabled` is the master switch; with it off, agents cannot post to Slack at all. Channel posting additionally needs `agentPostToChannelsEnabled` and the channel's ID in `agentPostChannelIds`; DMs need `agentDmEnabled` and the user's ID in `agentDmUserIds`, or `agentDmAnyUser` to allow DMing anyone in the workspace. **These lists fail closed:** an empty list authorizes nothing, which is the opposite of `allowedSlackUserIds`, where an empty list disables the restriction entirely. The bot must still be a member of any channel it posts to.
```

- [ ] **Step 4: Add a Usage bullet**

After the existing `ask_human` bullet in Usage:

```markdown
- Agents can call **`slack_post_message`** to post to an allowlisted channel or DM an allowlisted user, optionally threading under an existing message via `threadTs`. If someone replies to a DM the bot sent, that reply is handled like any other DM — it starts or continues a chat session with the default agent, and does not go back to the agent that sent the message.
```

- [ ] **Step 5: Verify**

Run: `npm test && npm run typecheck && npm run build`
Expected: PASS. `npm run build` catches anything the two typecheck passes miss in emit.

- [ ] **Step 6: Commit**

```bash
git add README.md package.json src/constants.ts
git commit -m "feat: slack_post_message tool for agent-initiated Slack messages (v0.8.0)"
```

---

## Verification checklist

Run at the end, before any publish:

- [ ] `npm test` — all suites pass
- [ ] `npm run typecheck` — both `tsc --noEmit` and `tsc -p tsconfig.test.json` clean
- [ ] `npm run build` — emits without error
- [ ] `git log --oneline` shows six commits, one per task
- [ ] Defaults confirm the tool is off out of the box: `agentPostMessageEnabled` is `false` in `DEFAULT_CONFIG` and in the manifest schema
