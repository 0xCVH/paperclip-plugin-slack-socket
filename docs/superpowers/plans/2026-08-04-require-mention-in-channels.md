# Require an @mention in Channels — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop the Slack bot from replying to unmentioned messages in channels — including threads the bot itself started — while leaving 1:1 DMs untouched.

**Architecture:** `src/chat.ts` exposes `handleMention` (wired to Slack's `app_mention` event) and `handleMessage` (wired to Slack's `message` event) in `src/worker.ts:376-386`. Today `handleMessage` converses whenever the message is a DM **or** plugin state holds a session for the thread root. The second condition is deleted: outside a 1:1 DM, nothing but an explicit mention reaches the agent. Session state, `handleMention`, `ask_human`, notifications, and the cleanup job are all unchanged.

**Tech Stack:** TypeScript (ESM, `tsc`), Vitest, `@slack/bolt` Socket Mode, `@paperclipai/plugin-sdk`.

**Design doc:** `docs/superpowers/specs/2026-08-04-require-mention-in-channels-design.md`

## Global Constraints

- Do not change `handleMention`, `getOrCreateSession`, `converse`, or `streamReply` — the only production edit in this plan is the body of `handleMessage`.
- Do not change session state shape, `STATE_KEYS`, or the cleanup job. No migration.
- DM behavior (`channelType === "im"`) must stay exactly as it is, including replies to DMs the bot sent proactively.
- The `<@${botId}>` early return must stay **ahead** of the DM branch: `app_mention` fires in DMs too, and without it a mentioned DM is answered twice.
- Only `channelType === "im"` gets mention-free treatment. `"group"` (private channel) and `"channel"` (public channel and group DM/mpim) require a mention.
- Run tests with `npm test` (Vitest) and types with `npm run typecheck` (checks `tsconfig.json` and `tsconfig.test.json`).
- Version for this change: `0.9.0` in both `src/constants.ts` (`PLUGIN_VERSION`) and `package.json` (`version`).

---

## File Structure

| File | Responsibility | Change |
|---|---|---|
| `src/chat.ts` | Slack chat routing and agent session turns | Modify `handleMessage` (lines 294-308) |
| `tests/chat.test.ts` | Chat routing unit tests | Invert one test, delete one, add three |
| `README.md` | User-facing behavior docs | Update lines 9, 79, 84, 93 |
| `src/constants.ts` | `PLUGIN_VERSION` | Bump to `0.9.0` |
| `package.json` | Package version | Bump to `0.9.0` |

---

### Task 1: Channels require an explicit @mention

**Files:**
- Modify: `src/chat.ts:290-310` (the returned object's `handleMessage`)
- Test: `tests/chat.test.ts`

**Interfaces:**
- Consumes: `createChat({ ctx, gateway, getConfig, updateIntervalMs })` from `src/chat.ts`; the `setup()` helper and `dm()` helper at `tests/chat.test.ts:6-20`; `FakeGateway` and `makeCtx` from `tests/helpers.ts`. `FakeGateway.botUserId()` returns `"UBOT"`. `makeCtx()` returns `{ ctx, stateStore, emitEvent }` where `stateStore` is a `Map` keyed by bare `stateKey` strings.
- Produces: `Chat.handleMessage(msg: InboundMessage): Promise<void>` — unchanged signature, narrowed behavior. `Chat.handleMention` is untouched.

- [ ] **Step 1: Branch off main**

The repo is on `main` and clean. Do not commit to `main`.

```bash
git checkout -b fix/require-mention-in-channels
```

- [ ] **Step 2: Invert the channel-thread test**

In `tests/chat.test.ts`, replace the whole test starting at line 50 — `it("handles a channel thread reply when a session exists for the thread", ...)` — with this one. It seeds the exact same state and sends the exact same message; only the assertions flip.

```ts
  it("ignores an unmentioned channel thread reply even when a session exists for the thread", async () => {
    const { ctx, gateway, chat, stateStore } = setup();
    stateStore.set(STATE_KEYS.session("C1", "50.1"), {
      sessionId: "sess-9", channel: "C1", threadTs: "50.1", lastActivityAt: new Date().toISOString(),
    });
    await chat.handleMessage({
      channel: "C1", channelType: "channel", user: "U1", text: "follow-up", ts: "50.2", threadTs: "50.1",
    });
    expect(ctx.agents.sessions.sendMessage).not.toHaveBeenCalled();
    expect(ctx.agents.sessions.create).not.toHaveBeenCalled();
    expect(gateway.posts).toHaveLength(0);
  });
```

- [ ] **Step 3: Add the reported-regression test**

Add this immediately after the test from Step 2. It reproduces the real incident: the bot posted the thread root in a private channel (`channelType: "group"`), a human replied without mentioning it, and the bot answered.

```ts
  it("ignores an unmentioned reply in a bot-started thread — the reported regression", async () => {
    const { ctx, gateway, chat, stateStore } = setup();
    // The thread root is the bot's own proactive post. State holds a session
    // for it — however it got there; see the design doc's "Why the current
    // code allows it". After this change the channel path never reads it.
    stateStore.set(STATE_KEYS.session("C-FEED", "1000.1"), {
      sessionId: "sess-sweep", channel: "C-FEED", threadTs: "1000.1",
      lastActivityAt: new Date().toISOString(),
    });
    await chat.handleMessage({
      channel: "C-FEED", channelType: "group", user: "U-HUMAN",
      text: "there are currently only 80 Open Findings, not 83 - please re-check",
      ts: "1000.2", threadTs: "1000.1",
    });
    expect(ctx.agents.sessions.sendMessage).not.toHaveBeenCalled();
    expect(gateway.posts).toHaveLength(0);
  });
```

- [ ] **Step 4: Add the mention-still-works test**

Add this immediately after the test from Step 3. It proves the change did not break the escape hatch: an explicit mention in that same bot-started thread still answers, and reuses the thread's existing session rather than creating a second one. `app_mention` always arrives with `channelType: "channel"` (`src/bolt-gateway.ts:31-41` hardcodes it), which is why this message says `"channel"` while Step 3's says `"group"`.

```ts
  it("still answers an @mention inside a bot-started thread, reusing that thread's session", async () => {
    const { ctx, chat, stateStore } = setup();
    stateStore.set(STATE_KEYS.session("C-FEED", "1000.1"), {
      sessionId: "sess-sweep", channel: "C-FEED", threadTs: "1000.1",
      lastActivityAt: new Date().toISOString(),
    });
    await chat.handleMention({
      channel: "C-FEED", channelType: "channel", user: "U-HUMAN",
      text: "<@UBOT> please re-check the count", ts: "1000.3", threadTs: "1000.1",
    });
    expect(ctx.agents.sessions.create).not.toHaveBeenCalled();
    expect(ctx.agents.sessions.sendMessage).toHaveBeenCalledWith("sess-sweep", "co-1", expect.anything());
  });
```

- [ ] **Step 5: Add the DM-unchanged test**

Add this immediately after the test from Step 4. The DM tests at lines 23 and 34 cover a DM the *user* opened; this one covers a reply to a thread inside a DM, which is the shape a proactive `slack_post_message` DM produces. It must keep working with no mention.

```ts
  it("still converses on an unmentioned DM thread reply (proactive-DM replies keep working)", async () => {
    const { ctx, chat, stateStore } = setup();
    stateStore.set(STATE_KEYS.session("D1", "200.1"), {
      sessionId: "sess-dm", channel: "D1", threadTs: "200.1", lastActivityAt: new Date().toISOString(),
    });
    await chat.handleMessage(dm("thanks, got it", "200.2", "200.1"));
    expect(ctx.agents.sessions.sendMessage).toHaveBeenCalledWith("sess-dm", "co-1", expect.anything());
  });
```

- [ ] **Step 6: Delete the test for the removed code path**

Delete the whole test starting at `tests/chat.test.ts:147` — `it("does not throw when ctx.state.get rejects during handleMessage's channel-thread routing", ...)`. After this change `handleMessage` never calls `ctx.state.get` on the channel path, so there is nothing left to reject.

- [ ] **Step 7: Run the tests and confirm they fail for the right reason**

```bash
npm test -- tests/chat.test.ts
```

Expected: the tests from Steps 2 and 3 FAIL — `sendMessage` was called and `gateway.posts` has one entry (the `_Thinking…_` placeholder). The tests from Steps 4 and 5 PASS already (they describe behavior that exists today and must survive). If Step 4 or 5 fails now, stop — the baseline is not what this plan assumed.

- [ ] **Step 8: Narrow `handleMessage`**

In `src/chat.ts`, replace the `handleMessage` body (lines 294-308) with the version below. Delete the `if (!msg.threadTs) return;` line, the `try/catch`, and the `ctx.state.get` lookup entirely.

```ts
    async handleMessage(msg) {
      const botId = gateway.botUserId();
      if (botId && msg.text.includes(`<@${botId}>`)) return; // the app_mention event handles it
      if (msg.channelType === "im") await converse(msg);
      // Channels, private channels and group DMs: only an explicit @mention
      // (delivered as app_mention, handled above) starts or continues a
      // conversation. A thread reply is not addressed to the bot just
      // because the bot is in the thread — an agent that posts proactively
      // would otherwise turn every human follow-up under its own message
      // into an agent turn, including replies people meant for each other.
      // Mentioning the bot again in the same thread reuses that thread's
      // session (see getOrCreateSession), so continuity is not lost.
    },
```

- [ ] **Step 9: Run the tests**

```bash
npm test -- tests/chat.test.ts
```

Expected: PASS, including the four tests added or inverted above.

- [ ] **Step 10: Run the full suite and the typechecker**

```bash
npm test && npm run typecheck
```

Expected: both clean. `tests/worker.test.ts:198` (`"does not drop a channel @mention when its message.channels event (same ts) is processed first"`) depends on the `<@${botId}>` guard that Step 8 kept, so it must still pass. If `typecheck` reports an unused import in `src/chat.ts`, do **not** remove `STATE_KEYS` or `stateScope` — `getOrCreateSession` still uses both; re-check the edit instead.

- [ ] **Step 11: Commit**

```bash
git add src/chat.ts tests/chat.test.ts
git commit -m "fix: require an explicit @mention to reply in channels

An agent posting proactively created a thread whose replies were routed
back to the agent without anyone addressing the bot, so human follow-ups
under a bot's message became agent turns. handleMessage no longer treats
a stored thread session as consent to reply outside a 1:1 DM.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 2: Documentation and version bump

**Files:**
- Modify: `README.md` (lines 9, 79, 84, 93)
- Modify: `src/constants.ts:5` (`PLUGIN_VERSION`)
- Modify: `package.json:3` (`version`)

**Interfaces:**
- Consumes: the behavior shipped in Task 1.
- Produces: nothing other code imports. `PLUGIN_VERSION` is a string constant exported from `src/constants.ts`.

- [ ] **Step 1: Fix the Agent chat feature bullet (README line 9)**

Find this sentence inside the `- **Agent chat** —` bullet:

> Replying inside that thread continues the same agent session without needing to mention the bot again.

Replace it with:

> In a channel the bot replies only when it is explicitly `@mention`ed — every turn needs the mention, including in threads the bot itself started — and mentioning it again in the same thread continues the same agent session. In a 1:1 DM no mention is needed.

- [ ] **Step 2: Fix the usage bullet (README line 79)**

Replace the whole line:

```markdown
- **Reply in the thread** to continue the same agent session — no need to `@mention` the bot again once a thread has an active session.
```

with:

```markdown
- **Reply in the thread with another `@mention`** to continue the same agent session. In channels the bot answers only when it is explicitly mentioned; a thread reply that doesn't mention it is ignored, including in threads the bot itself started (e.g. an agent's `slack_post_message` post or a notification). In a 1:1 DM, no mention is needed for any message.
```

- [ ] **Step 3: Fix the mpim note (README line 84)**

Replace the whole line:

```markdown
**Note:** multi-person group DMs (mpim) are treated the same as channels — the bot only responds in an mpim thread that already has an active session; it does not start new sessions there the way it does in a 1:1 DM. Starting a conversation in an mpim isn't currently supported.
```

with:

```markdown
**Note:** multi-person group DMs (mpim) are treated the same as channels — the bot replies only when it is explicitly `@mention`ed, and ignores everything else. The mention-free behavior described above applies to 1:1 DMs only.
```

- [ ] **Step 4: Fix smoke-test step 4 (README line 93)**

Replace the whole line:

```markdown
4. Reply again in that same thread without mentioning the bot → the conversation continues in the same agent session.
```

with:

```markdown
4. Reply again in that same thread **without** mentioning the bot → nothing happens; the bot ignores it. Reply once more **with** an `@mention` → the conversation continues in the same agent session (no new session is created).
```

- [ ] **Step 5: Leave the security bullet alone**

`README.md:103` (`- **Optional Slack user allowlist.**`) describes the allowlist surfaces and already frames channel access as `@mention`-based. It contains no claim about mention-free thread continuation. Read it to confirm, then make no edit.

- [ ] **Step 6: Bump the version in both places**

In `src/constants.ts:5`:

```ts
export const PLUGIN_VERSION = "0.9.0";
```

In `package.json:3`:

```json
  "version": "0.9.0",
```

- [ ] **Step 7: Verify**

```bash
npm test && npm run typecheck && npm run build
```

Expected: all clean. `tests/manifest.test.ts` reads `PLUGIN_VERSION`, so a mismatch between the two version strings or a stale expectation surfaces here. `npm run build` regenerates `dist/` (gitignored) — the deployed plugin runs from `dist/`, so this must succeed before redeploying.

- [ ] **Step 8: Commit**

```bash
git add README.md src/constants.ts package.json
git commit -m "docs: channels require an @mention; bump to 0.9.0

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Manual verification (after deploying the rebuilt plugin)

1. Have an agent post a top-level message in a channel via `slack_post_message`.
2. Reply in that thread **without** mentioning the bot → no `_Thinking…_` placeholder, no reply.
3. Reply in the same thread **with** an `@mention` → the bot answers.
4. Reply again without a mention → still ignored.
5. DM the bot "hello" → it answers, as before.
6. Have an agent `slack_post_message` a DM to you and reply to it → it answers, as before.
