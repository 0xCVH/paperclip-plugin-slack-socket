# Paperclip Slack Socket Mode Plugin — Design

**Date:** 2026-08-01
**Status:** Approved (design); pending implementation plan
**Package name:** `paperclip-plugin-slack-socket`

## Summary

A new Paperclip plugin that connects a Slack workspace to a Paperclip instance over
**Slack Socket Mode** — an outbound WebSocket, so the Paperclip instance needs no
public URL. Modeled on Multica's Slack bot UX: DM the bot or @mention it in a
channel and it converses via a Paperclip agent session. Adds configurable
notifications (issues, agent failures, approvals with buttons) and a
`slack_ask_human` agent tool that lets agents ask humans questions in Slack and
records the answer onto an issue.

Built from scratch on `@slack/bolt` (Socket Mode) + `@paperclipai/plugin-sdk`,
borrowing proven patterns (Block Kit formatters, config conventions, approval
REST calls) from `mvanhorn/paperclip-plugin-slack` rather than forking it.

## Decisions made during brainstorming

| Decision | Choice |
|---|---|
| Scope | Multica-style chat bot + issue command + notifications (not a full port of the existing plugin) |
| Agent routing | One configured default agent (per-channel overrides deferred) |
| Notifications (all UI-toggleable) | Issue created/completed; agent errors/run failures; approvals with Approve/Reject buttons; ask-human requests (reaction or free-text answer recorded to an issue) |
| Identity | No Slack↔Paperclip user mapping in v1; comments are plugin-attributed with the Slack display name in the text |
| Approach | Fresh codebase on `@slack/bolt` with `socketMode: true` |

## Architecture

- **Runtime:** a Paperclip plugin worker (`definePlugin` + `runWorker`) — a
  long-lived out-of-process Node process, which is what a persistent WebSocket
  needs.
- **Transport:** one Bolt `App` with `socketMode: true` created in `setup()`.
  All inbound traffic (DMs, mentions, slash commands, button clicks, emoji
  reactions) arrives over the socket. The manifest declares **zero webhooks**.
- **Tokens:** two Paperclip secret references — Bot token (`xoxb-`) and
  App-level token (`xapp-`, scope `connections:write`).
- **Lifecycle:** config changes rely on the host's default behavior (no
  `onConfigChanged` hook → the host restarts the worker, giving a clean slate
  and avoiding double-registered event handlers); `onShutdown` stops the
  socket; `onHealth` reports live socket state (and secret-resolution
  failures) to the Paperclip health dashboard.

### Modules

| Module | Responsibility |
|---|---|
| `manifest.ts` | Capabilities, config schema, jobs — no webhooks |
| `worker.ts` | `setup()` wiring; lifecycle hooks |
| `slack-app.ts` | Bolt app creation, lifecycle, reconnect/health state |
| `chat.ts` | DM + @mention → Paperclip agent session bridge |
| `notifications.ts` | Domain events → Block Kit messages, per-type toggles/channel routing |
| `approvals.ts` | Approval notifications + Approve/Reject button handling |
| `ask-human.ts` | `slack_ask_human` agent tool (reaction / free-text answer) |
| `commands.ts` | `/paperclip issue <text>`, `/paperclip help` |
| `formatters.ts` | Block Kit builders |
| `constants.ts`, `types.ts` | Shared identifiers and types |

The Bolt app is injected behind a thin interface so every module is testable
without a network.

## Feature flows

### Chat (core)

- One agent session per Slack thread. A DM or @mention starting a new thread
  creates a session with the configured default agent
  (`ctx.agents.sessions.create(defaultAgentId, companyId)`); replies in the
  thread reuse the session. The thread↔session mapping lives in `ctx.state`.
- Agent responses stream via `sendMessage`'s `onEvent` callback. The plugin
  posts one reply message in the thread and edits it as chunks arrive,
  throttled to ~1 `chat.update` per second.
- A scheduled cleanup job closes sessions idle longer than `sessionIdleHours`
  (default 24) and prunes their state entries.
- Chat handler errors post a short apology in the thread instead of failing
  silently.

### Notifications

Subscriptions: `issue.created`, `issue.updated` (transition to done),
`agent.run.failed`, `approval.created`. Each type has an enable toggle and an
optional channel override in settings, falling back to `defaultChannelId`.
Approval messages include Approve/Reject buttons; a click calls the Paperclip
REST API (`POST {paperclipBaseUrl}/api/approvals/:id/approve|reject` via
`ctx.http` with `decisionNote: "Decided via Slack by <userName> (slack:<user>)"`
in the body — the server ignores `decidedByUserId` in the body and instead
uses the authenticated actor, but does record `decisionNote`), updates the
Slack message inline, and records the acting Slack user in the activity log.
That endpoint requires a "board" actor: in `local_trusted` deployment mode
every request is implicitly board and no header is needed, but in
`authenticated` mode the plugin must send `Authorization: Bearer <board API
key>`, resolved from the optional `paperclipApiKeyRef` config field. (The
SDK's `ctx.approvals.decide` client exists only on paperclip main, not in the
published SDK `2026.722.0` — revisit when it ships.)

### `slack_ask_human` tool

Registered via `ctx.tools.register`. Parameters: `question` (string), `target`
(channel ID or Slack user ID → DM), `mode` (`"reaction"` | `"answer"`),
`issueId` (where the response is recorded), optional `timeoutMinutes`.

Flow: post the question as a Block Kit message → store a pending-question
record in `ctx.state` keyed by message `ts` → listen over the socket for
`reaction_added` (reaction mode) or a thread reply (answer mode) → record the
response as an issue comment (`ctx.issues.createComment`, plugin-attributed
with the responder's Slack display name) → `ctx.issues.requestWakeup` so the
assigned agent resumes → edit the Slack message to show it's resolved and
clear the pending record. The tool returns immediately after posting
("question posted"); the answer arrives asynchronously via the issue comment
and wakeup. Timed-out questions are marked expired by the cleanup job and a
note is recorded on the issue.

### Slash command

`/paperclip issue <text>` creates an issue (`ctx.issues.create`) in the
configured company and replies ephemerally with a link.
`/paperclip help` lists usage. (Slash commands also arrive over Socket Mode.)

## Configuration (instance settings)

| Field | Notes |
|---|---|
| `slackBotTokenRef` | secret-ref, required |
| `slackAppTokenRef` | secret-ref, required |
| `companyId` | company for sessions/issues, required |
| `defaultAgentId` | agent handling chat, required |
| `defaultChannelId` | fallback notification channel, required |
| `notifyOnIssueCreated` / `notifyOnIssueDone` / `notifyOnAgentRunFailed` / `notifyOnApprovalCreated` | booleans |
| `issuesChannelId` / `errorsChannelId` / `approvalsChannelId` | optional per-type overrides |
| `paperclipBaseUrl` | dashboard links + approvals REST (load-bearing for both) |
| `paperclipApiKeyRef` | optional secret-ref; board API key for approval decisions in `authenticated` deployments (not needed in `local_trusted`) |
| `sessionIdleHours` | default 24 |

`onValidateConfig` (Test Connection): resolves both secrets and calls Slack
`auth.test`, returning actionable errors to the settings UI.

### Capabilities (manifest)

`issues.create`, `issue.comments.create`, `issues.wakeup`,
`agent.sessions.create`, `agent.sessions.send`, `agent.sessions.close`,
`agent.tools.register`, `http.outbound`,
`events.subscribe`, `plugin.state.read`, `plugin.state.write`,
`secrets.read-ref`, `instance.settings.register`,
`activity.log.write`, `metrics.write`, `jobs.schedule`.

(`companies.read`, `issues.read`, and `agents.read` were dropped in the final
review pass: no code path calls `ctx.companies`, `ctx.issues.list`/`.get`, or
`ctx.agents.list`/`.get` — sessions are addressed by id, not looked up.)

(`http.outbound` covers only the approval REST calls; all Slack traffic goes
through Bolt's own clients. The published SDK `2026.722.0` has no
`approvals.read`/`approvals.respond` capabilities — they exist only on
paperclip main.)

(Least-privilege: only capabilities the flows above actually use.)

### Slack app manifest (shipped in repo)

Bot scopes: `app_mentions:read`, `chat:write`, `im:history`, `im:read`,
`im:write`, `channels:history`, `groups:history`, `reactions:read`,
`users:read`, `commands`. Socket Mode enabled; events: `app_mention`,
`message.im`, `message.channels`, `message.groups`, `reaction_added`; slash
command `/paperclip`.

Setup: create Slack app from the manifest → install to workspace → copy bot
token + create app-level token → store both as Paperclip secrets → paste
secret refs and IDs into plugin settings → Test Connection.

## Error handling

- Bolt auto-reconnects the socket with backoff; while disconnected `onHealth`
  reports `degraded` with details. The worker never crashes on handler errors.
- `@slack/web-api` built-in rate-limit (`Retry-After`) and retry handling for
  outbound calls.
- Bolt acks Slack envelopes within the 3-second window automatically; handlers
  run post-ack.
- Secret-resolution failure at startup → `degraded` health with a clear
  message (pattern borrowed from the existing plugin), features disabled until
  config is fixed.

## Security

- **Attack surface:** Socket Mode eliminates all inbound HTTP (no Events API
  endpoint, no signing-secret verification needed — the connection is outbound
  and authenticated by the app token).
- **Secrets:** tokens only in Paperclip secrets, resolved at startup, never
  logged, never echoed to config or Slack.
- **Untrusted input:** all Slack content is untrusted. Message text is passed
  to agents only as conversational prompts. Privileged actions (approve/
  reject) occur only via button interactions; the acting Slack user ID is
  recorded in the activity log.
- **Remaining risk (accepted for v1):** any workspace member who can DM the
  bot can converse with the default agent and use `/paperclip issue`.
  Channel/user allowlists are a candidate v2 hardening.

## Testing

- vitest + `createTestHarness` from the SDK for worker logic.
- Fake Bolt interface drives synthetic Slack events (messages, mentions,
  reactions, button clicks, slash commands) — no network in tests.
- Unit tests: formatters, thread↔session mapping, pending-question lifecycle
  (including timeout), notification routing/toggles, config validation.
- README documents a manual end-to-end smoke test against a real workspace.

## Out of scope (v1)

Identity mapping/self-binding links, per-channel agent routing, media
transcription, custom `!command` workflows, proactive suggestions, HITL
escalation engine, channel/user allowlists.

## Deliverables

The plugin package in this repo, the Slack app manifest JSON, and a README
setup guide.
