# paperclip-plugin-slack-socket

A Paperclip plugin that connects Slack to Paperclip over [Socket Mode](https://api.slack.com/apis/socket-mode) — Paperclip opens an outbound WebSocket connection to Slack, so no public URL, reverse proxy, or inbound webhook endpoint is required. Install it, paste in two Slack tokens and a handful of IDs, and your Paperclip agents are reachable from Slack.

## What it is

This plugin lets people talk to Paperclip agents from Slack and lets Paperclip push updates back into Slack, all over a single Socket Mode connection. Concretely it provides:

- **Agent chat** — DM the bot, or `@mention` it in a channel it has been invited to, to start a conversation with your configured default agent. By default, only the agent's final reply is posted to the thread once it's ready (a `_Thinking…_` placeholder is shown until then); enabling `streamPartialReplies` instead streams the agent's raw output into the thread live as it arrives. Replying inside that thread continues the same agent session without needing to mention the bot again. Each Slack turn is framed as a conversation (via `chatPromptPreamble`) rather than as Paperclip's default autonomous-work wake, so agents reply directly instead of narrating their heartbeat reasoning.
- **Notifications** — Paperclip posts to Slack when an issue is created, when an issue is marked done, and when an agent run fails, each independently toggleable, with an optional per-category channel override (falling back to a default channel).
- **Approvals with buttons** — when Paperclip requests an approval, the plugin posts a message with Approve/Reject buttons; clicking one calls the Paperclip REST API to decide the approval and updates the Slack message in place to show the outcome.
- **The `ask_human` tool** — agents can pause and ask a human a question in Slack, either via an emoji reaction or a threaded text reply. The response is recorded as a comment on a Paperclip issue and wakes the issue's agent back up.
- **`/paperclip issue <title>`** — a slash command that creates a Paperclip issue from Slack and replies with a link, visible only to the person who ran it.

## Install the plugin

Paperclip installs plugins instance-wide from an npm package name or a local path, via any of three equivalent routes:

- **Paperclip UI** — **Settings → Plugins → Install**, then enter the npm package name.
- **CLI** — `paperclipai plugin install <npm-package-or-absolute-path>`.
- **REST API** — `POST /api/plugins/install` with a JSON body of `{"packageName": "...", "isLocalPath": true|false}`.

The package is published on npm as [`paperclip-plugin-slack-socket`](https://www.npmjs.com/package/paperclip-plugin-slack-socket), so the normal install is by name through any of the three routes:

```sh
paperclipai plugin install paperclip-plugin-slack-socket
```

or enter `paperclip-plugin-slack-socket` in **Settings → Plugins → Install**, or `POST /api/plugins/install` with `{"packageName": "paperclip-plugin-slack-socket"}`.

For development, you can install from a local clone instead:

```sh
git clone https://github.com/0xCVH/paperclip-plugin-slack-socket
cd paperclip-plugin-slack-socket
npm install
npm run build
```

then install the **absolute path** to that clone — UI (paste the absolute path where it asks for a package name), CLI (`paperclipai plugin install /absolute/path/to/paperclip-plugin-slack-socket`), or REST (`{"packageName": "/absolute/path/to/paperclip-plugin-slack-socket", "isLocalPath": true}`).

Per Paperclip's plugin spec, the host running Paperclip needs a writable filesystem, `npm` available on its `PATH`, and (for npm-name installs) network access to the npm registry.

## Slack setup

1. Go to [api.slack.com/apps](https://api.slack.com/apps) and click **Create New App**.
2. Choose **From an app manifest**, pick the workspace you want to install into, and paste the contents of [`slack-app-manifest.json`](./slack-app-manifest.json) from this repo when prompted. Review and create the app.
3. On the app's **Install App** page, click **Install to Workspace**, approve the requested scopes, and then copy the **Bot User OAuth Token** (starts with `xoxb-`) — you'll need it in Paperclip.
4. Go to **Basic Information** → **App-Level Tokens** and click **Generate Token and Scopes**. Give it a name, add the `connections:write` scope, and generate it. Copy the resulting **App-Level Token** (starts with `xapp-`) — this is what lets Socket Mode open its connection.

That's it on the Slack side — the manifest already enables Socket Mode, declares the bot events (`app_mention`, `message.channels`, `message.groups`, `message.im`, `reaction_added`), interactivity (for the approval buttons), and the `/paperclip` slash command, and requests the minimum bot scopes the plugin needs (`app_mentions:read`, `chat:write`, `channels:history`, `groups:history`, `im:history`, `im:read`, `im:write`, `reactions:read`, `users:read`, `commands`).

## Paperclip setup

1. In Paperclip, go to **Settings → Secrets** and create two secrets: one holding the Bot User OAuth Token (`xoxb-…`) and one holding the App-Level Token (`xapp-…`). Note the secret reference Paperclip shows for each (the settings form's secret-ref fields store whatever the Secrets page provides — the plugin passes it through opaquely and never sees the raw value).
2. Install the plugin into your Paperclip instance (plugin id `cvh.slack-socket`) — see [Install the plugin](#install-the-plugin) above.
3. Open the plugin's instance settings and fill in:
   - **Slack Bot Token (secret reference)** — use the field's secret picker to select the bot token secret from step 1. The picker stores a secret reference, which is what the plugin resolves at runtime; typing a raw UUID into the field instead will fail to resolve.
   - **Slack App-Level Token (secret reference)** — likewise, pick the app token secret from step 1.
   - **Company ID** — the Paperclip company UUID used for sessions, issues, and approvals.
   - **Default Agent ID** — the agent that handles DM and @mention conversations.
   - **Default Slack Channel ID** — the fallback channel for notifications (e.g. `C01ABC2DEF3`).
   
   These five fields are required. Optionally set per-category notification toggles (`notifyOnIssueCreated`, `notifyOnIssueDone`, `notifyOnAgentRunFailed`, `notifyOnApprovalCreated`, all on by default), per-category channel overrides (`issuesChannelId`, `errorsChannelId`, `approvalsChannelId` — each falls back to the default channel when unset), a `paperclipBaseUrl` (see below), `sessionIdleHours` (default 24) controlling how long an idle chat session stays open before the cleanup job closes it, `streamPartialReplies` (default **off**) — when off, only the agent's final, canonical reply is posted to the thread; when on, raw adapter output is streamed live into the thread as it arrives, which for some adapters (e.g. `claude_local`) includes agent-runtime notices and the model's internal reasoning/deliberation, not just the final answer. Leave this off unless you specifically want live streaming and accept that tradeoff. — and `chatPromptPreamble` (default: a short instruction telling the agent it's replying to a person in a Slack thread and to answer directly and conversationally instead of narrating its reasoning). This text is prepended to every Slack chat message before it's sent to the agent, framing the turn as a conversation rather than autonomous work — which is what otherwise causes agents to narrate wake-payload/execution-contract reasoning before their actual reply. Set it to an empty string to send the user's message verbatim with no framing.
   - **Paperclip Base URL** (`paperclipBaseUrl`) — the base URL of your Paperclip instance. This is load-bearing, not just cosmetic: it's used both to build dashboard links in Slack messages *and* as the target of the approval decision REST calls (`POST {paperclipBaseUrl}/api/approvals/:id/approve|reject`).
   - **Paperclip Board API Key** (`paperclipApiKeyRef`, optional) — a secret reference to a Paperclip API key for a board-role user. Leave empty if your Paperclip instance runs in `local_trusted` deployment mode (every request is implicitly a board actor there). Set it if your instance runs in `authenticated` mode — approval decisions (the Approve/Reject buttons) need to authenticate as a board user, and the plugin sends this key as an `Authorization: Bearer` header on those requests.
4. **Press Save before Test Connection the first time.** Paperclip grants a plugin access to secrets per *configured* company, and that authorization is seeded from the plugin's saved config rows — so until you have saved once, Test Connection cannot resolve your tokens and will report that the configuration has not been saved yet. After the first save, Test Connection works normally: it calls Slack's `auth.test` with the bot token (verifies it's valid) and `apps.connections.open` with the app token (verifies it has `connections:write` and Socket Mode can be established). A missing or malformed token, or a token missing the `connections:write` scope, are the most common failures.
5. Save. Paperclip authorizes a plugin to act on a company from background work (which is all of this plugin's Slack traffic — chat messages, mentions, reactions, commands) using the set of companies with a saved configuration. Once saved, the plugin resolves both secrets, opens the Socket Mode connection, and registers the `ask_human` tool and the `*/15 * * * *` cleanup job (which closes agent sessions idle beyond `sessionIdleHours` and expires unanswered `ask_human` questions past their `timeoutMinutes`, default 1440).

Config is applied live — Paperclip pushes the updated config to the running plugin on every save, so there's no worker restart to wait for. The plugin always resolves the two Slack secrets, and everything scoped by company (agent sessions, issues, approvals), against the **Company ID** configured in step 3 above; it doesn't infer company scope from anything else, so make sure that field points at the company you intend the bot to act on behalf of.

## Usage

- **DM the bot** from the Apps section of Slack's sidebar to start a private conversation with the default agent.
- **In a channel**, first `/invite @paperclip` (the bot only sees channel messages after being invited), then `@mention` it to start a thread-scoped conversation.
- **Reply in the thread** to continue the same agent session — no need to `@mention` the bot again once a thread has an active session.
- Run **`/paperclip issue <title>`** anywhere to create a Paperclip issue; the confirmation with a link is ephemeral (only you see it), which requires the bot to be a member of the channel the command was run in — `/invite @paperclip` first, or run the command in a DM with the bot. (The issue is still created even if the bot isn't in the channel; only the confirmation message would fail to post.) `/paperclip help` shows usage.
- Agents can call the **`ask_human`** tool mid-run to ask a person a question in Slack (by channel or by DMing a user), either waiting for an emoji reaction (`mode: "reaction"`) or a threaded text reply (`mode: "answer"`); the response is attached to the issue as a comment and the issue is woken up.

**Note:** multi-person group DMs (mpim) are treated the same as channels — the bot only responds in an mpim thread that already has an active session; it does not start new sessions there the way it does in a 1:1 DM. Starting a conversation in an mpim isn't currently supported.

## Manual smoke test checklist

After installing and configuring the plugin, walk through this checklist end-to-end in a real Slack workspace:

1. Plugin health shows **OK** after configuring the required fields and pressing Test Connection.
2. DM the bot "hello" → a streamed agent reply appears in the thread.
3. `@mention` the bot in a channel it has been invited to → it replies in a thread.
4. Reply again in that same thread without mentioning the bot → the conversation continues in the same agent session.
5. Create an issue in Paperclip → a Slack notification appears in the configured (or default) channel.
6. Create an approval in Paperclip → Approve/Reject buttons appear in Slack; clicking **Approve** updates the message in place to show it was approved.
7. Have an agent call `ask_human` with `mode: "reaction"` → react to the posted question with an emoji → a comment recording the response lands on the referenced Paperclip issue.
8. Run `/paperclip issue Test` → an ephemeral message with a link to the new issue appears.

## Security notes

- **Zero inbound HTTP surface.** Socket Mode means Paperclip connects out to Slack; there is no webhook endpoint, no public URL, and nothing for an attacker to send unsolicited requests to.
- **Tokens live only in Paperclip Secrets.** The plugin config stores secret UUIDs, never raw token values; the bot and app tokens are resolved from Paperclip's secret store at runtime and are never logged.
- **No allowlisting yet.** Any workspace member who can DM the bot can converse with the configured default agent, and anyone who can `@mention` it in a channel it's been invited to can do the same. There is currently no per-user or per-channel allowlist — restricting who can talk to the bot is a matter of who is in the workspace and which channels it's invited to. Tighter access control (e.g. an allowlist of Slack user or channel IDs) is future work.
