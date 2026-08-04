# Require an @mention in channels

**Date:** 2026-08-04
**Status:** Approved, ready for implementation
**Affects:** `src/chat.ts`, `tests/chat.test.ts`, `README.md`, `src/constants.ts`, `package.json`

## Problem

An agent posted a top-level message in the private channel `feed_paperclip_triage`.
A human replied in that thread without mentioning the bot ("there are currently
only 80 Open Findings, not 83 - please re-check"). The bot answered anyway,
roughly eleven minutes later, via the plugin's chat path — the `_Thinking…_`
placeholder followed by a `chat.update` with the agent's reply.

That is unwanted. A thread reply is not addressed to the bot merely because the
bot is in the thread. In a channel where agents post proactively, every human
follow-up turns into an agent turn, and the bot inserts itself into
conversations between people.

### Why the current code allows it

`chat.handleMessage` (`src/chat.ts:294-308`) routes an unmentioned message to
the agent when either:

- the message is a 1:1 DM (`channelType === "im"`), or
- `ctx.state.get` returns a truthy value for `session:<channel>:<thread_ts>`.

The observed reply came through the second branch, which means state held a
truthy entry under that thread's key. The only writer of that key in this repo
is `getOrCreateSession` (`src/chat.ts:118-138`), reachable only from a mention
or a DM, so how the entry came to exist for a bot-rooted thread is not
explained by this codebase. Candidates considered:

1. Someone @mentioned the bot inside that thread at some earlier point.
   `converse` keys the session to `msg.threadTs ?? msg.ts` — the bot's own root
   message — after which every later reply in the thread qualifies.
2. The host's `state.get` returns something truthy for a key that was never
   set, or resolves keys loosely. The SDK type docs promise `null` for a missing
   entry, but the published SDK is known to lag the host.

**This design does not depend on which is true.** Under the new rule the
channel path never reads session state, so neither candidate can produce a
reply. Candidate 2, if real, would still let a *mention* in thread A resume the
session of thread B via `getOrCreateSession` — out of scope here, recorded as a
follow-up below.

## Decision

In channels, private channels, and group DMs, only an explicit `@mention`
(the `app_mention` event) starts or continues a conversation. Direct messages
are unchanged.

Rejected alternatives:

- **Only auto-continue threads a top-level mention started** (session key ts ==
  the mention's own ts). Preserves mention-free follow-ups in
  human-initiated threads, but keeps the state-lookup branch alive and leaves
  bystanders in those threads able to drive the agent.
- **Only auto-continue for the user who opened the session.** Orthogonal to
  thread provenance and still leaves the bot answering that one user
  mention-free in a thread it started.
- **A config flag to restore the old behavior.** YAGNI. Can be added later if
  anyone wants it back.

## Change

`chat.handleMessage` keeps its DM branch and drops everything after it:

```js
async handleMessage(msg) {
  const botId = gateway.botUserId();
  if (botId && msg.text.includes(`<@${botId}>`)) return; // app_mention handles it
  if (msg.channelType === "im") await converse(msg);
  // Channels, private channels and group DMs: only an explicit @mention
  // (app_mention) starts or continues a conversation. A thread reply is
  // not addressed to the bot just because the bot is in the thread.
}
```

Notes on the shape:

- The `<@bot>` guard stays **ahead** of the DM branch. `app_mention` fires in
  DMs as well as channels; without the guard a mentioned DM would be answered
  twice.
- The `ctx.state.get` call and its surrounding `try/catch` are deleted along
  with the branch. `stateScope`/`STATE_KEYS` remain imported for
  `getOrCreateSession`.
- `bolt-gateway.ts` maps `channel_type` to `"im" | "group" | "channel"`, and
  group DMs (mpim) fall into `"channel"`. Only `"im"` — a true 1:1 DM — keeps
  mention-free conversation.

## What is unaffected

- **`handleMention`** is untouched. Because `getOrCreateSession` keys on
  `msg.threadTs ?? msg.ts`, mentioning the bot again in the same thread resumes
  the *same* agent session. Continuity is preserved; each turn just needs the
  `@`.
- **DMs**, including replies to a DM the bot sent proactively via
  `slack_post_message` (README line 82).
- **`ask_human` mode `"answer"`.** `askHuman.tryHandleAnswer` runs before chat
  routing (`src/worker.ts:384`) and matches on its own `question:<channel>:<ts>`
  key, so a threaded answer to a bot's question still resolves with no mention.
- **Session state and cleanup.** No shape change, no migration. Sessions are
  still created per thread and still reaped by the cleanup job on
  `sessionIdleHours`.
- **`slack_post_message`, notifications, approvals.** Unchanged.

## Testing

`tests/chat.test.ts`:

- Invert `"handles a channel thread reply when a session exists for the thread"`
  (line 50) — seed the same session entry, send the same unmentioned channel
  thread reply, and assert `sessions.sendMessage` was **not** called and nothing
  was posted to the gateway.
- Delete `"does not throw when ctx.state.get rejects during handleMessage's
  channel-thread routing"` (line 147). It covers a code path that no longer
  exists.
- Keep `"ignores channel messages without an existing thread session"` (line 42)
  as-is; it still passes and still describes intended behavior.
- Add: a reply in a bot-started channel thread that holds a session produces no
  agent call — the regression this change exists to prevent.
- Add: `handleMention` on a thread reply still converses and reuses the existing
  session for that thread root.
- Existing DM tests (lines 23, 34) must continue to pass unchanged; they are the
  guard that this change did not narrow DM behavior.

## Documentation

`README.md` states mention-free thread continuation in four places — lines 9,
79, 84, and 93. Each needs to say that channels require an `@mention` every
turn and that DMs do not. Line 93 is step 4 of the smoke test ("Reply again in
that same thread without mentioning the bot") and must be rewritten as a
negative check followed by a mention.

Line 103 (the `allowedSlackUserIds` bullet) was reviewed and needs no edit: it
already frames channel access as `@mention`-based and makes no claim about
mention-free thread continuation.

## Versioning

`PLUGIN_VERSION` in `src/constants.ts` and `version` in `package.json` go to
`0.9.0`. This removes documented behavior, so it is not a patch.

## Security note

The change only narrows attack surface. Before it, any user permitted by
`allowedSlackUserIds` (empty by default, meaning anyone in a channel the bot
was invited to) could drive an agent session by replying in a thread that
happened to carry session state. After it, driving an agent in a channel
requires deliberately addressing the bot. No new input is trusted and no new
code path is added. Residual risk: DMs remain open to any allowlisted user, as
before.

## Follow-ups (not in scope)

- Determine how `session:<channel>:<thread_ts>` came to hold a truthy value for
  a bot-rooted thread. If the host's `state.get` is resolving keys loosely, a
  mention in one thread could resume another thread's session through
  `getOrCreateSession` — a real bug this change does not address.
- Meeseeks' reply rendered `@Gordon Bishop` as a live mention. `escapeMrkdwn`
  neutralizes `<@U…>` sequences, so a separate path is producing it. Related to
  the known mrkdwn mention-injection issue.
