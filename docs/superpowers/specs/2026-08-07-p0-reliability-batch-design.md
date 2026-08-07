# P0 reliability batch

**Date:** 2026-08-07
**Status:** Approved, ready for implementation
**Target release:** 0.10.0
**Affects:** `src/chat.ts`, `src/worker.ts`, `src/ask-human.ts`, `src/cleanup.ts`,
`src/approvals.ts`, `src/access.ts`, `src/post-message.ts`, `src/commands.ts`,
`src/bolt-gateway.ts`, `src/gateway-proxy.ts`, `src/constants.ts`, `src/types.ts`,
`src/manifest.ts`, `src/message-link.ts` (new), `.github/workflows/ci.yml` (new),
`tests/*`, `README.md`, `package.json`

## Problem

A multi-agent audit of the plugin (8 discovery agents, 8 adversarial verifiers,
a 3-lens judging panel and a completeness critic) produced 91 verified
improvements. This spec covers the eight highest-ranked, plus one follow-on the
batch itself creates. They are grouped here because they share a single theme:
**the plugin can currently fail silently in ways a user or operator cannot
diagnose from the outside**, and two of them are correctness bugs that make a
headline feature not work at all.

The nine items, with the defect each addresses:

1. **A chat turn can hang forever.** `streamReply`'s promise settles only on a
   `done` event, an `error` event, or a `sendMessage` rejection
   (`src/chat.ts:208-260`). `sendMessage` returns immediately with `{ runId }`
   and events arrive asynchronously, so if the host restarts or the JSON-RPC
   event stream stalls, nothing ever settles: the `_Thinking…_` placeholder
   stays forever and `converse` never returns. There is no timeout anywhere in
   the path.

2. **1:1 DMs have no memory.** `converse` keys sessions on
   `msg.threadTs ?? msg.ts` (`src/chat.ts:265`), so every *top-level* DM message
   creates a fresh agent session with an empty context, and forces the reply
   into a one-message thread under itself. Continuity exists only if the user
   deliberately replies inside the thread the bot created — which nobody does in
   a DM, because a DM is a chat window. In channels the same line is correct and
   intentional: the thread is the conversation unit and continuity works.

3. **An expired `ask_human` question never wakes its agent.** The cleanup job
   posts a comment and strikes the Slack message (`src/cleanup.ts:49-68`) but
   never calls `requestWakeup`. Per the SDK, plugin-attributed comments wake
   nobody, so the asking agent hangs until an unrelated wake. The answered path
   (`src/ask-human.ts:37-45`) does call it — only the timeout path forgets.

4. **`ask_human` is missing the cross-tenant guard.** `slack_post_message`
   refuses tool calls whose `runCtx.companyId` differs from the bound config
   company (`src/post-message.ts:59-66`), precisely because the host can route
   another company's agent run into this single-tenant worker. `ask_human` has
   no such check: another company's agent can post questions into the bound
   company's Slack workspace, and the harvested human answer is written to *that
   other company's* issue, since `pending.companyId = runCtx.companyId`
   (`src/ask-human.ts:93`). This is a cross-tenant data path.

5. **A decision made in the Paperclip web UI leaves live Slack buttons.** Only
   `approval.created` is subscribed (`src/approvals.ts:25`) and the posted
   message's `{channel, ts}` is discarded, so nothing can update it later. The
   buttons stay clickable forever and a later click dead-ends in the vague
   `"It may already be decided."` ephemeral (`src/approvals.ts:133`) after a
   blind REST round-trip.

6. **Messages carrying an attachment vanish entirely.** Slack delivers file
   uploads with `subtype: "file_share"`, and the guard at
   `src/bolt-gateway.ts:52` drops every subtype except `thread_broadcast`. In a
   DM, a message with an attachment therefore never reaches chat routing at all
   — including its text. The user sees no reply and no error.

7. **A permanently dead socket is never retried.** Bolt's socket-mode client
   stops reconnecting on unrecoverable failures (invalid/revoked/rotated token,
   and — per verification — exhausted network retries), and `applyConfig` has no
   retry path. If `gateway.start()` throws, the previous gateway has already
   been stopped (`src/worker.ts:355-358`) and the plugin sits degraded until an
   operator manually re-saves config.

8. **No CI.** There is no `.github/` directory. `npm test` (222 tests) and
   `npm run typecheck` exist but nothing runs them on push or pull request.

9. **Continuous DMs need an eraser.** Item 2 makes a DM accumulate context until
   it idles out after `sessionIdleHours` (default 24). Shipping the memory
   without a way to say "forget that, start over" is half a feature.

## Non-goals

- No change to channel behavior. An explicit `@mention` remains required on
  every turn in public channels, private channels and group DMs, sessions there
  remain thread-scoped, and replies remain threaded. That design is deliberate
  (see `2026-08-04-require-mention-in-channels-design.md`) and is untouched.
- No change to the final-reply-only default, the `<slack_reply>` extraction, the
  escape-before-convert pipeline, or the fail-closed outbound posting
  allowlists.
- No new Slack OAuth scopes. Reading file *contents* (`files:read`) is out of
  scope; item 6 only stops discarding messages that already arrive.
- No lifting of the single-tenant company bind.
- No refactor beyond the two extractions the batch itself forces (see Approach).

## Approach

Fix in place, and extract only the duplication this batch makes real:

- **`src/message-link.ts`** — "post a message, remember `{channel, ts}` against
  an entity id, update it later, prune it." `src/notifications.ts:59-70` and
  `src/cleanup.ts:75-92` already implement this for issues; item 5 makes
  approvals the second caller. Extracted on the second caller, not
  speculatively.
- **`checkToolCompany()` in `src/access.ts`** — item 4 needs the guard at
  `src/post-message.ts:59-66` to exist identically in `ask-human.ts`. Two copies
  of a security check that must never drift belong in one place, and `access.ts`
  is already the pure-decision module (no `ctx`, no gateway, 22 tests).

Rejected: a pure minimal diff (leaves a third copy of the message-link pattern
and a hand-written second copy of a security check), and a state-layer refactor
first (that is the separate P3 `durable-state-database` project; mixing it into
a bug-fix release balloons the review surface and delays the fixes).

The two watchdogs stay separate. Item 1 is a per-turn timer living inside
`streamReply`; item 7 is a process-level poll. Sharing them would be abstraction
for its own sake.

## Design

### Commit sequence

One branch `p0-reliability` off `main`, eleven commits, released as 0.10.0.
CI lands first so the pipeline is proven before code lands on it; the cheapest
isolated fixes follow; the chat changes are grouped and ordered so each builds
on the last; the refactor precedes its first new consumer; the riskiest change
(item 7, which touches the config pump) lands last.

| # | Commit | Item |
|---|---|---|
| 1 | `ci: typecheck, test and audit on push and PR` | 8 |
| 2 | `fix: let messages with attachments reach chat` | 6 |
| 3 | `fix: wake the asking agent when an ask_human question expires` | 3 |
| 4 | `fix: refuse cross-tenant ask_human calls` | 4 |
| 5 | `fix: time out hung agent turns instead of hanging on Thinking` | 1 |
| 6 | `feat: continuous 1:1 DM sessions` | 2 |
| 7 | `feat: /paperclip reset and an in-thread reset keyword` | 9 |
| 8 | `refactor: extract entity-to-Slack-message links` | — |
| 9 | `feat: sync approval messages decided outside Slack` | 5 |
| 10 | `feat: auto-recover the Socket Mode connection` | 7 |
| 11 | `chore: 0.10.0` | — |

### Session scoping (item 2)

All chat scoping decisions move into one pure, testable function:

```ts
export type DmSessionMode = "channel" | "thread";

export function resolveSessionScope(
  msg: InboundMessage,
  mode: DmSessionMode,
): { key: string; scope: "channel" | "thread"; replyThreadTs: string | undefined };
```

Rules:

| Input | Key | Reply |
|---|---|---|
| `channelType === "im"`, no `threadTs`, `mode === "channel"` | `session:<channel>:main` | top-level (`replyThreadTs: undefined`) |
| `channelType === "im"`, inside a thread | `session:<channel>:<threadTs>` | threaded |
| any non-`im` channel, or `mode === "thread"` | `session:<channel>:<threadTs ?? ts>` | threaded |

The third row reproduces today's behavior exactly for every non-DM surface and
for operators who set `dmSessionMode: "thread"`.

`SessionEntry` gains `scope: "channel" | "thread"` so a stored entry is
self-describing rather than depending on downstream code interpreting a `"main"`
sentinel. Overflow chunks for a top-level DM reply thread under the reply
message itself — the pattern `src/post-message.ts:118` already uses — so a long
answer does not spray top-level messages down the DM.

New config field:

- `dmSessionMode` (`"channel" | "thread"`, default `"channel"`). Default chosen
  because today's behavior is the defect: nothing depends on the bot forgetting
  the previous line. `"thread"` restores today's behavior exactly.

Existing state entries keyed `session:<dmChannel>:<ts>` are left alone; they
idle out through the normal cleanup path. No migration.

### Turn watchdog (item 1)

Inside `streamReply`: a single timer, reset on **every** received event
(`chunk`, `status`, `done`, `error`). On expiry it sets a `settled` flag, clears
the pending chunk timer, rewrites the placeholder, resolves the promise, and
writes `slack.turns.timedout`.

Placeholder text on timeout:

> ⏳ No response from the agent after 10m — it may still be working. Mention me
> again to retry.

This is deliberately not phrased as failure, because the run may well still be
alive. Resolving the promise unblocks `converse` so the turn cannot wedge.

If a `done` arrives **after** `settled`, its reply is posted as a **new** message
in the same thread, marked as a late reply, rather than overwriting the
placeholder. Real work is not discarded, and a stale buffer can never clobber a
message the user has already read. `settled` also guards the existing
`done`/`error` branches so nothing double-posts.

New config field:

- `turnTimeoutMinutes` (number, default `10`). Tests inject milliseconds through
  a `turnTimeoutMs` dep, mirroring the existing `updateIntervalMs` precedent
  (`src/chat.ts:16`).

### Reset (item 9)

`/paperclip reset` closes the agent session for the current channel and deletes
its state entry and index membership, reusing the `ctx.agents.sessions.close`
path `src/cleanup.ts:29` already exercises, then confirms ephemerally.

Slack slash commands carry `channel_id` but **no `thread_ts`**, so the slash
command cannot target a specific channel thread. This makes the two surfaces
behave differently, and the spec is explicit about it rather than leaving it to
be discovered:

- **In a 1:1 DM**, `/paperclip reset` clears the channel-scoped session — the
  conversation item 2 introduces. This is the common case and it works.
- **In any other channel**, every session is thread-scoped by design, so there
  is nothing a thread-blind command could correctly target. Rather than
  reporting a misleading "no session to reset", it replies with an ephemeral
  pointing at the mechanism that does work: mention the bot with `reset` in the
  thread you want cleared.

For threads, an exact-match mention keyword handles it: `@paperclip reset` —
after mention-stripping, trimmed, lower-cased, with nothing else in the message
— resets that thread's session and confirms in-thread. Exact match only, so it
cannot fire on "reset the staging database".

Both paths reply with a friendly ephemeral when there is no session to clear. A
failed `sessions.close` still drops local state: a stale host session is
strictly better than a thread wedged to a dead session id. Failures are reported
truthfully, following the precedent at `src/commands.ts:52` (never report
failure for something that succeeded).

### `ask_human` expiry wakeup (item 3)

The expiry branch takes the answered path's exact shape from
`src/ask-human.ts:37-45`:

1. `ctx.issues.createComment(...)`
2. `ctx.issues.requestWakeup(pending.issueId, pending.companyId, { reason: "slack_ask_human_timeout", contextSource: "slack-socket.ask-human" })`, in its own try/catch
3. `gateway.updateMessage(...)` with `formatQuestionExpired`

Ordering is load-bearing: a wakeup failure must not stop the Slack message from
being struck through, and a failed comment correctly skips both (there is
nothing to wake about). State deletion stays outside the try, so a question can
never be stranded in the index.

### Cross-tenant guard (item 4)

```ts
export function checkToolCompany(
  configCompanyId: string,
  runCompanyId: string,
  actionLabel: string,
): { allowed: true } | { allowed: false; reason: string };
```

`reason` is `` `${actionLabel} is not authorized for this company.` `` and never
names the bound company. `actionLabel: "Posting to Slack"` reproduces
`src/post-message.ts:65`'s current string byte-for-byte, so existing tests stay
green; `ask_human` passes `"Asking a human via Slack"`.

Logging and refusal metrics stay at the call sites — `access.ts` takes no `ctx`
and remains pure. `AskHumanDeps` gains `getConfig`, wired at `src/worker.ts:194`,
guarded by the same defensive try/catch as `src/post-message.ts:42-47`, because
`getConfig` carries no non-throwing guarantee and a tool handler must never
throw. New metric `slack.questions.refused`.

### `message-link.ts` (refactor, commit 8)

```ts
export interface MessageLink { channel: string; ts: string; createdAt: string }

linkMessage(ctx, indexKey, key, posted): Promise<void>
getMessageLink(ctx, key): Promise<MessageLink | null>
unlinkMessage(ctx, indexKey, key): Promise<void>
pruneMessageLinks(ctx, indexKey, maxAgeMs, now): Promise<void>
```

`IssueThreadEntry` becomes `MessageLink` (identical shape). Index maintenance
continues to go through `updateIndex` (`src/state-index.ts`), preserving its
serialized read-modify-write guarantee. `STATE_KEYS` keeps `issueThread` /
`issueThreadIndex` and gains `approvalMessage` / `approvalMessageIndex`.

**Acceptance criterion for this commit:** `tests/notifications.test.ts` and
`tests/cleanup.test.ts` pass **unchanged**. If either needs editing, the
refactor changed behavior — stop and reassess rather than adjusting the tests.

### `approval.decided` sync (item 5)

- On posting an approval message, `linkMessage("approval:<id>", { channel, ts })`.
- New `ctx.events.on("approval.decided", { companyId }, …)`: look up the link;
  absent → no-op; present → rewrite the message to the decided state (buttons
  removed) and unlink.
- `handleAction` unlinks **immediately after the REST call succeeds and before
  its own `updateMessage`**, so the `approval.decided` the host echoes back from
  our own button click finds no link and no-ops. Without this, the echo would
  overwrite "Approved by Dana" with generic web-UI text.

Trade-off accepted: if that `updateMessage` then fails, the message keeps live
buttons with no link, and a later click lands on today's existing
`"It may already be decided."` ephemeral. That is the pre-existing failure mode,
not a new one, and it is logged.

The event payload shape and whether `revision_requested` is terminal are
host-defined, and the published SDK may lag the host. The formatter therefore
degrades gracefully: an unrecognized status still strips the buttons and states
the raw status rather than guessing. Decider attribution is used when the
payload carries it and omitted otherwise.

Approval links prune at 30 days, alongside issue threads.

### Attachment messages (item 6)

The subtype guard moves out of the constructor closure into an exported pure
predicate so it is unit-testable without a Bolt app:

```ts
const PASSTHROUGH_SUBTYPES = new Set(["thread_broadcast", "file_share"]);
export function shouldDispatchMessage(m): boolean;
```

Bot filters (`bot_id`, missing `user`) are unchanged. The message's `text` flows
to chat as normal; attachment *contents* are not read (that needs `files:read`,
and is the separate P2 `file-ingest` item).

### Socket auto-recovery (item 7)

`SlackGateway` gains `probe(): Promise<boolean>` — `auth.test` through
`app.client`, `false` on any throw. `gateway-proxy` returns `false` when
unconfigured. This is deliberately the minimum independent liveness signal, so
recovery never rests solely on `isConnected()`, which reaches into Bolt's
private receiver internals (`src/bolt-gateway.ts:133-137`) with optional
chaining and would silently never flip if Bolt's shape changed. The full
observability item stays in P1.

`startSocketWatchdog(ctx)` is called once from `setup()` — the same clean-ALS-
store reasoning as `startConfigPump` — on a 60s interval. Each tick skips when:
there is no `liveConfig`; a recovery is already in flight; `applyQueue` is
non-empty; or the backoff deadline has not elapsed. Otherwise: gateway connected
**and** `probe()` true → reset backoff and return; anything else → recover.

Recovery **pushes `liveConfig` onto `applyQueue` and calls `signalPump()`**. It
must never call `applyConfig` directly. This is the load-bearing invariant
documented at `src/worker.ts:97-123`: a timer callback could otherwise construct
the Slack gateway inside a captured invocation store, after which every Slack
event echoes the id of an invocation the host finished long ago and is denied
with "unknown invocation scope".

Backoff: 1m → 2m → 4m → 8m → 15m cap, reset on a healthy tick.

Two verified edges are handled explicitly:

- After a failed `gateway.start()`, `currentGateway` holds a **dead, non-null**
  gateway, because it is assigned at `src/worker.ts:400` before the try. The
  liveness check must therefore probe, not test for a missing gateway.
- If that failure rolled back the claim (`didClaim`), re-applying simply
  re-claims `boundCompanyId`, which is correct.

Recovery re-resolves both secret refs as a side effect of `applyConfig`, so a
rotated token is picked up without an operator save.

`onHealth` reports `"Slack Socket Mode disconnected; recovery attempt N"` while
backing off. Metrics: `slack.socket.recovery.attempted`, `.succeeded`,
`.failed`.

### CI (item 8)

`.github/workflows/ci.yml`, triggered on push and pull request:

- matrix Node 20 and 22
- `npm ci`, `npm run typecheck` (covers both tsconfigs), `npm test`
- `npm audit --audit-level=high`, blocking
- `permissions: contents: read`, actions pinned by major version

Publishing stays manual; tag-driven release with provenance is a separate P3
item.

## Testing

Test-driven throughout: a failing test that demonstrates the defect, then the
fix. `FakeGateway` (`tests/helpers.ts`) gains `probe()`. Vitest fake timers
drive both watchdogs.

| Area | Coverage added |
|---|---|
| `chat` | `resolveSessionScope` truth table; DM continuity across three top-level messages; channels unchanged; turn timeout settles; late `done` posts a new message and does not overwrite; `settled` prevents double-post; reset keyword exact-match only |
| `commands` | `/paperclip reset` in a DM; in a channel; with no session |
| `ask-human` | cross-tenant call refused, nothing posted to Slack, no state written; matching-company call still works |
| `cleanup` | expiry calls `requestWakeup` with the right reason; wakeup failure still strikes the message and deletes state; approval links prune at 30 days |
| `approvals` | `approval.decided` updates a linked message; no-ops when unlinked; our own button click is not overwritten by the echoed event; unknown status degrades gracefully |
| `access` | `checkToolCompany` allow/refuse, and that `reason` never contains the bound company id |
| `message-link` | link/get/unlink/prune, index maintenance |
| `bolt-gateway` | `shouldDispatchMessage`: `file_share` passes, `message_changed` does not, bot messages do not |
| `worker` | watchdog enqueues onto `applyQueue` and never calls `applyConfig` directly; skips while an apply is in flight; backoff escalates and resets; dead-but-non-null gateway is detected |
| `manifest-config-schema` | both new config fields validate |

The three highest-value assertions: a stalled event stream settles the turn and
a late `done` still lands; the echoed `approval.decided` does not overwrite the
decider's name; and the watchdog reaches the queue without ever calling
`applyConfig` directly.

## Security

**Closed.** A cross-tenant data path: another company's agent could post
`ask_human` questions into the bound company's Slack workspace and have the
human's answer recorded against its own issue. Now refused with the same
fail-closed check `slack_post_message` uses.

**Reduced.** Silent unavailability — hung turns and permanently dead sockets
that neither users nor operators could see or recover from without manual
intervention.

**New surface.** One new inbound command (`/paperclip reset`) and one mention
keyword, both behind the existing `checkAccess` allowlist
(`src/worker.ts:90-95`), both destructive only to the caller's own conversation
session. Two new non-secret config fields. `npm audit --audit-level=high` now
gates merges.

**Unchanged.** No new Slack OAuth scopes. No new outbound capability. No change
to the escape-before-convert pipeline, the `<slack_reply>` extraction, the
fail-closed posting allowlists, or the single-tenant bind.

**Remaining.** `ask_human` still has no operator-controllable target allowlist,
so an agent may still post question text to any channel the bot is in or DM any
user (P2 `ask-human-target-allowlist`). Approval decisions still ride raw REST
against an operator-configured base URL with a manually configured board key
(P2 `rest-decision-hardening`). Anyone on `allowedSlackUserIds` can still decide
any approval (P1 `approver-allowlist`).

## Rollout

Config defaults are chosen so an operator who upgrades and changes nothing gets
the fixes: `dmSessionMode: "channel"`, `turnTimeoutMinutes: 10`. The one
user-visible behavior change is that 1:1 DM replies now post top-level instead
of threaded, and remember previous messages. README documents both, and
`dmSessionMode: "thread"` is documented as the exact-restore switch.

The manual smoke-test checklist in README gains: send three consecutive
top-level DM messages and confirm the third recalls the first; `/paperclip
reset` then confirm the next message starts fresh; decide an approval in the
Paperclip web UI and confirm the Slack message updates and its buttons vanish.
