# Mention relay: a person's @mention lands on the thread's issue without an agent

Status: implemented in 0.13.0 (this branch). Base: 0.12.0 (`867cdf2`).
Companion to `record_on_issue` (0.12.0), which this does not replace.

## The problem, stated as the operator experiences it

A monitor escalates POL-3099 into Slack; the bot posts the root. A day later a
person replies in that thread, mentioning the bot: "the fix implemented was
PR #53". The intent is obvious — that sentence belongs on POL-3099, and the
issue's owner should see it — and the bot should answer the person with the
thread as context.

What happened on the production host (2026-09-29/30):

1. The agent's `POST /api/issues/:id/comments` was refused with
   `cross_issue_influence_run_context_required`. A chat run the plugin
   starts carries no issue in its context (`plugin-host-services.js`
   `sessions.sendMessage` builds the snapshot from fixed fields, and the
   plugin has no parameter to add one), and the host's guard throws before
   it compares source and target.
2. The agent fell back to `record_on_issue` (0.12.0). The tool gateway
   denied it: `deny_default`, "No effective tool profile, grant, or allow
   policy permits this call." Plugin tools are `providerType:
   "paperclip_plugin"`; the Slack agent's effective profiles are seven
   app-wizard profiles with `catalog_entry` selectors, none of which can
   match a plugin tool. Policy dry runs through the agent's per-run
   gateways return the same denial, and the same is true for `ask_human`
   from every other agent on the host: in 14 days of journal there is not
   one successful `POST /plugins/tools/execute`. The plugin's whole tool
   surface has been dark since install.
3. The agent spent 5m47s working that out and replied in Slack with the
   diagnosis. The person's sentence reached the issue only through a
   courier child issue (POL-3206) assigned to the owning agent.

## Why not the obvious fixes

- **Grant the tool.** A tool profile with a `tool_name` include for
  `cvh.slack-socket:record_on_issue`, bound to the Slack agent, makes the
  0.12.0 path work. It leaves a model in the write path (turn-length
  latency, paraphrase, refusal codes the agent may or may not act on), it
  exercises a route that has never once succeeded on the host, and it is a
  standing allow that lives outside the plugin, in host configuration that
  agent or profile changes can silently drop. It remains the right fix for
  the *secondary* case — the agent's own note, or an issue a person named —
  and is deliberately not part of this change.
- **Make the run issue-bound.** Would let the normal comments API work.
  Impossible from the plugin: the host builds the run context.
- **Change the host.** Out of scope by policy; the plugin is the place.

## What this change does

The plugin itself relays the mention, deterministically, before the agent
is woken, and tells the agent about it.

```
app_mention ──► chat.handleMention ──► converse
                  │ post "_Thinking…_"
                  │ relay.relayMention(msg)          ◄── new
                  │     resolve thread → issue (thread-issue.ts)
                  │     ctx.issues.createComment(issue, quoted words)
                  │     ctx.issues.requestWakeup(assignee)
                  │ seed / delta thread history (unchanged)
                  │ prompt = preamble + LINKED-ISSUE CONTEXT + seed + message
                  └ sessions.sendMessage (unchanged)
```

`ctx.issues.createComment` is the plugin-host path `ask_human` has always
used to put a human's Slack answer on an issue; it does not run the
cross-issue guard, and the manifest already holds `issue.comments.create`,
`issues.read` and `issues.wakeup`. No new capability, no new Slack scope
(`chat.getPermalink` needs none; `users.info` and `conversations.replies`
are already granted).

### Which thread belongs to which issue

`src/thread-issue.ts`, extracted from `record-on-issue.ts` so the tool and
the relay can never disagree. A thread's *own* issue is, in order:

1. the plugin's `thread-issue:<channel>:<root ts>` record, written when the
   plugin posted the root for an issue (notifications);
2. an issue link on `paperclipBaseUrl` in a root that this bot posted, is at
   most 90 days old, and is not an agent-worded post (`agent-post:` record:
   `slack_post_message`, `ask_human`, a channel-scoped DM reply).

A link a person pasted, or in a root any other bot posted, links nothing.
If the two sources name different issues the relay writes nothing
(`ambiguous_linked_issue`). If no issue resolves, the turn is an ordinary
chat turn.

### What is written

```
**Human input from Slack** — <display name> (<slack user id>), <ISO time> — <permalink>

> <the person's words, verbatim, Slack entities rendered as Markdown>

---
Relayed automatically by the Slack plugin from an @mention in <origin>. These are the person's words, not the agent's.
```

Attributed to the Slack agent (`authorAgentId`). The plugin does not hold
`issue.comments.create_human_attributed`, and mapping a Slack user to a
Paperclip member is a separate feature (see below). The Slack user id in
the header is the unforgeable part, as in the thread transcript labels.

Slack mrkdwn → Markdown is `src/slack-markdown.ts`: `<url|label>` becomes
`[label](url)`, `<@U…>` becomes `@U…`, `<#C…|name>` becomes `#name`,
`<!here>` becomes `@here`, HTML escapes are undone. Formatting is left as
typed. The bot's own mention is removed. Over 8,000 characters is cut with
a marker, not refused.

### Refusals and skips

| Code | Meaning | Written? | Issue in prompt? |
|---|---|---|---|
| `dm`, `not_a_thread`, `empty`, `control_keyword` | not a relay situation | no | no |
| `no_linked_issue` | thread has no issue by the rules above | no | no |
| `ambiguous_linked_issue` | plugin link and root link disagree | no | no |
| `issue_not_found` | linked ref no longer resolves | no | no |
| `disabled` | `relayMentionsToIssue: false` | no | **yes** |
| `low_trust_target` | issue under `trustPreset`/`reviewPreset`/`trustBoundary` | no | **yes** |
| `bot_author` | the mention was posted by a bot, or has no author | no | no |
| `lookup_failed` | an issue lookup threw; refs that resolved are not trusted alone | no | no |
| `write_failed` | `createComment` rejected | no | **yes** |

The trust-policy refusal mirrors `record_on_issue`: the host's comment route
tags and quarantines agent comments on such issues; this path cannot, so it
must not write there at all.

### Idempotency

Socket Mode is at-least-once and a reconnect can replay a backlog. Two
guards: an in-process `Map<channel:ts, Promise>` so overlapping deliveries
share one outcome, and a persisted `relayed-mention:<channel>:<ts>` record
(pruned after 7 days by the cleanup job) so a redelivery after a restart
returns the original comment id instead of writing again. The assignee
wake carries `idempotencyKey: slack-mention-relay:<channel>:<ts>`.

### The prompt

`buildChatPrompt(preamble, text, seed, context)` gains a fourth, *trusted*
argument placed with the preamble, ahead of the untrusted `<thread_context>`
block, never inside or after it. Empty context reproduces the previous
output byte for byte. `buildLinkedIssueContext` renders:

```
Linked Paperclip issue: POL-3099 — "<title, one line, ≤200 chars>" (status: …, assignee: …)
https://…/POL/issues/POL-3099
This person's message has already been recorded on POL-3099 as comment <id>. Do not record it again — answer them, and read the issue over the API if you need more than the thread shows.
```

or, when not written, `…was not recorded on the issue (<why>). Tell them if
they ask.` The title is flattened because issue titles are frequently built
from alert text; it must not be able to contribute a line of its own.

### What the relay never does

- Write to any issue other than the thread's own.
- Wake the Slack agent (it is being woken for the reply anyway), or the
  assignee of a `done`/`cancelled` issue.
- Block the conversation: every failure is logged and the turn proceeds
  without a context block. `createChat` without a `relay` is unchanged.
- Run for DMs, top-level mentions, `reset`, an empty mention, or a mention
  posted by a bot (`bot_id` / `bot_message`): another integration's or
  another agent's words are never written as human input.
- Hold the turn: the relay stage is bounded at 20 s (`relayTimeoutMs`);
  past it the turn proceeds without issue context while the relay finishes
  in the background. It is started before the session lookup so its calls
  overlap that wait and the write lands even if the session cannot be created.

## Trust boundary moved

Before: anyone who can mention the bot could put text in front of the
*Slack* agent. After: the same people can put text, verbatim and quoted, in
front of the issue's *owning* agent as a comment on that issue, with no
model between them and the write. `allowedSlackUserIds` bounds the set
exactly as for every other inbound surface; trust-policy issues are never
written to; the header makes the provenance unmistakable to the reading
agent. This is stated in the README's Security notes, next to the seeding
note it parallels.

## Not in this change (follow-ups)

- **Human attribution.** `createComment` supports `actorUserId` behind the
  capability `issue.comments.create_human_attributed`; the host then wakes
  the assignee through its ordinary human-comment path. Needs a Slack user →
  Paperclip member mapping (an operator-maintained map, or `users:read.email`
  plus `access.members.list`). Adds two capabilities and, depending on the
  route, a Slack scope; separate PR.
- **Relaying non-mention replies** in issue threads. Same machinery, a
  different trust boundary (text from people who never addressed the bot).
- **Recording the bot's reply** too, so the issue carries the whole
  exchange. A config switch; deferred until someone wants it.
- **An explicit relay gesture** (a 📌 reaction, or `@bot note …`) for
  relaying someone else's message.

## Deploying on the host

1. Install 0.13.0 and restart `paperclip.service` (human-approved step).
2. Confirm the plugin's `paperclipBaseUrl` is the exact origin the escalation
   links use. If it is not, only notification threads relay.
3. Update the Slack agent's instructions (`paperclip-slack-AGENTS.md`, held
   on the host, not in this repo): job 1 becomes "the plugin already
   recorded the message — confirm with the comment link and answer; use
   `record_on_issue` only for a note of your own or an issue a person named".
4. Verify with one real mention in a live escalation thread: the comment on
   the issue, the header, the activity-log row (`slack.mention_relay`), the
   assignee wake, and the bot's reply naming the issue. Then mention it in a
   thread with no issue and confirm nothing is written.
