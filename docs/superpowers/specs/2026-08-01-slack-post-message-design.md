# `slack_post_message` — agent-initiated Slack messages

Design for a second agent tool in `paperclip-plugin-slack-socket`, alongside
`ask_human`: it lets an agent post a message to an allowlisted Slack channel,
or DM an allowlisted user.

## Motivation

Today an agent has no way to say something in Slack on its own initiative. Text
reaches Slack only through paths the plugin drives: a chat reply inside a
Slack-originated session, an `ask_human` question, or an event-driven
notification whose channel and wording the agent doesn't choose. An agent that
wants to report a result, flag something, or ping a person has to invent a
reason to create an issue or ask a question.

`slack_post_message` is the missing send primitive. It is deliberately one-way:
posting a message, not opening a conversation.

## Configuration

Six new fields on the instance config, each defaulting to its safe value.
Installing or upgrading the plugin therefore changes nothing until an operator
opts in.

| Field | Type | Default | Meaning |
|---|---|---|---|
| `agentPostMessageEnabled` | boolean | `false` | Master switch. Off → every call refused. |
| `agentPostToChannelsEnabled` | boolean | `false` | Channel posting on/off without clearing the list. |
| `agentPostChannelIds` | string[] | `[]` | Channel IDs the tool may post to. |
| `agentDmEnabled` | boolean | `false` | DM sending on/off without clearing the list. |
| `agentDmUserIds` | string[] | `[]` | User IDs the tool may DM. |
| `agentDmAnyUser` | boolean | `false` | When on, any workspace member may be DM'd and `agentDmUserIds` is ignored. |

### Fail-closed, unlike `allowedSlackUserIds`

The existing `allowedSlackUserIds` treats an empty list as *disabled* — no
restriction configured, so everyone may drive the bot. The two new lists invert
that: empty means *nothing authorized*.

The inversion is intentional. For an inbound gate, "unconfigured" reasonably
means "no restriction". For an outbound capability, "unconfigured" must mean
"no permission", or the tool would ship wide open to every channel the bot can
reach. It is also a genuine trap for the next reader of this config, so it gets
an explicit comment at the definition and a dedicated test asserting empty
refuses rather than allows.

`agentPostToChannelsEnabled` is partly redundant — an empty
`agentPostChannelIds` already refuses everything. It exists so an operator can
switch channel posting off without losing the configured list, mirroring
`agentDmEnabled`.

## The tool

Declared in `manifest.ts` and registered next to `ask_human`. The host
namespaces the name by plugin id at runtime.

```
name: slack_post_message

target    string   required   C…/G… channel ID, or U…/W… user ID to DM
text      string   required   message body, in markdown
threadTs  string   optional   post as a reply in this thread
```

Success returns `{ content, data: { channel, ts } }`, echoing the resolved
channel (the opened DM channel for user targets) and the message timestamp, so
an agent can thread its own follow-ups. Every failure returns `{ error }`; the
handler never throws.

Only IDs are accepted. `#channel-name` is not resolved, consistent with every
other channel field in the plugin, and consistent with `ask_human`'s `target`.

### Enforcement happens at call time, not registration time

The tool is registered in `setup()`, before any config has arrived, and config
is live-updatable. So the master switch cannot gate registration. An agent
always sees the tool; when posting is disabled it gets an error naming the
setting that refused it. Making the tool appear and disappear on config save
isn't achievable, and a stale tool list would be worse than a clear refusal.

### Replies are not routed back

Anything a human says in response is handled by existing routing, unchanged: a
reply in a DM with the bot starts or continues a normal chat session with the
default agent; a reply in a channel thread is ignored unless there is a live
session for that thread or the bot is `@mention`ed. The posting agent is not
notified. Two-way delivery is what `ask_human` is for.

## Access decision — `access.ts`

A pure function beside `isUserAllowed`:

```ts
export type PostTargetDecision =
  | { allowed: true; kind: "channel" | "dm"; target: string }
  | { allowed: false; reason: string };

export function checkPostTarget(
  config: SlackSocketConfig,
  target: string,
): PostTargetDecision;
```

Order of evaluation:

1. `agentPostMessageEnabled` false → refuse.
2. Trim `target`; empty → refuse.
3. Prefix decides the path, case-insensitively: `U` or `W` → DM, anything
   else → channel.
4. DM path: refuse unless `agentDmEnabled`. Then allow if `agentDmAnyUser`,
   otherwise allow only if the id is in `agentDmUserIds`.
5. Channel path: refuse unless `agentPostToChannelsEnabled`, then allow only if
   the id is in `agentPostChannelIds`.

List matching reuses the normalization `isUserAllowed` already applies: entries
and target are trimmed and compared case-insensitively, and blank entries are
ignored. Unlike `isUserAllowed`, an all-blank list does not mean "disabled".

Because the prefix alone selects the path, a `U…` id placed in
`agentPostChannelIds` can never match — the DM path never consults that list. A
test pins this so the misconfiguration fails loudly rather than mysteriously.

Keeping the decision pure and context-free makes the whole authorization matrix
unit-testable with no gateway and no plugin context, which is the same reason
`isUserAllowed` lives there.

`reason` is a short operator-facing string naming the setting responsible
("posting is disabled", "channel is not in agentPostChannelIds"). It is
returned to the agent verbatim as the tool error, so the agent can tell a
misconfiguration from a bad argument. It must never contain a resolved token or
any config value other than the setting's name.

## Handler — new `src/post-message.ts`

Same shape as `ask-human.ts`: a `createPostMessage({ ctx, gateway, getConfig })`
factory exposing `registerTool()`, so it can be built in `setup()` against the
gateway proxy before any config exists, matching how the other core modules are
wired in `worker.ts`.

Sequence:

1. Validate params. Missing/blank `target` or `text` → `{ error }`.
2. `checkPostTarget` against the live config. Refused → `{ error: reason }`,
   with no Slack call attempted and a `slack.messages.refused` metric.
3. DM targets: `gateway.openDm(userId)` to resolve the DM channel.
4. Format the text (below).
5. Post via `gateway.postMessage`, honouring `threadTs`.
6. Write `slack.messages.posted` with a `kind` tag of `channel` or `dm`.
7. Return the resolved channel and ts.

A Slack failure at step 3 or 5 is caught and returned as `{ error }` — the same
treatment `ask_human` gives a failed post.

### Formatting: escape first, then convert

Agent text is passed through `escapeMrkdwn` **before** `markdownToMrkdwn`.

The order is load-bearing. Escaping `&`, `<`, `>` on the raw text makes it
impossible for an agent to emit Slack's special sequences directly — `<!channel>`
and `<!here>` mass-pings, or a hand-authored `<https://evil|Click here>` whose
visible text hides its destination. Running the markdown conversion afterwards
still produces genuine link syntax from `[text](url)` the agent wrote as
markdown, so ordinary formatting keeps working. Converting first and escaping
second would destroy the conversion's own output.

Long text reuses the chat path's 3900-character limit: the first chunk is the
message, and any remainder is posted as threaded replies under it rather than as
further top-level messages. `MAX_MESSAGE_LENGTH` and `splitIntoChunks` move out
of `chat.ts` into a shared module so both call sites use one definition instead
of a copy.

## Adjacent fix: escaping in `chat.ts`

`chat.ts` calls `markdownToMrkdwn` on agent replies but never escapes them, so
an agent replying in a normal Slack conversation can already emit `<!channel>`
and ping everyone in the channel. This is the same one-line ordering fix and
lands in the same branch as a **separate commit**, with its own test.

## Testing

Test-driven, in `tests/post-message.test.ts` plus additions to
`tests/access.test.ts`, using the existing `FakeGateway`.

Access matrix (pure, no gateway):

- master switch off refuses both a valid channel and a valid DM target
- channel allowed when listed and `agentPostToChannelsEnabled`; refused when the
  switch is off, when the list is empty, and when the id is absent
- DM allowed when listed and `agentDmEnabled`; refused when the switch is off,
  when the list is empty, and when the id is absent
- `agentDmAnyUser` allows an unlisted user, and is itself still subject to
  `agentDmEnabled`
- `W…` (Enterprise Grid) targets take the DM path
- entries and targets are matched trimmed and case-insensitively; blank entries
  are ignored; an all-blank list refuses
- a `U…` id in `agentPostChannelIds` never authorizes anything

Handler (with `FakeGateway`):

- refusal posts nothing and returns `{ error }`
- blank `text` and blank `target` are refused
- `openDm` is called for `U…`/`W…` targets and not for channel targets, and the
  opened channel is what gets posted to and returned
- `<!channel>` in agent text arrives escaped and inert
- `[text](url)` markdown still arrives as a working Slack link
- text over the limit splits, with the remainder threaded under the first
  message
- `threadTs` is passed through
- a throwing gateway yields `{ error }`, not an exception
- metrics are written on both the posted and refused paths

## Threat note

**New attack surface.** A new outbound path from model output to humans: any
agent in the bound company can cause arbitrary text to appear in an allowlisted
Slack channel, or in a DM, attributed to the bot.

**Mitigations.** Fail-closed defaults at three levels — master switch, per-mode
switch, empty allowlist — so the capability is off until an operator makes three
deliberate choices. Refusal precedes any Slack API call. Escaping neutralizes
`@channel`/`@here` mass-pings and forged link targets. Messages are plain text
with no Blocks, so no buttons or other interactive elements can be injected.
Slack independently requires the bot to be a member of the target channel.
Refusal reasons name settings, never values, so no token or ID leaks into an
agent-visible error.

**Residual risk.** An agent can still author a markdown link whose visible text
misleads about its destination. An agent can post to any allowlisted channel
regardless of the task it is working on — the allowlist is a channel boundary,
not a relevance check. The capability is company-wide: every agent in the bound
company gets the tool, since the plugin has no way to express per-agent scoping.
And an agent that is itself prompt-injected through content it processed can be
made to post attacker-chosen text to an allowlisted channel; the allowlist bounds
where that lands, not what it says.

## Out of scope

- Editing or deleting an already-posted message.
- Uploading files or images.
- Blocks, attachments, or interactive elements.
- Resolving `#channel-name` or `@display-name` to IDs.
- Routing replies back to the posting agent — that is `ask_human`.
- Per-agent or per-project restriction of who may use the tool.
