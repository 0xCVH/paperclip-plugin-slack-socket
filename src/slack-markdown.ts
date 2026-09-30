// Slack mrkdwn -> Markdown, for text that leaves Slack and lands on a
// Paperclip issue (the mention relay). Only Slack's entity syntax is
// translated — `<url|label>`, `<@U…>`, `<#C…|name>`, `<!here>`, HTML
// escapes — because those render as raw angle-bracket noise in Markdown.
// Inline formatting (*bold*, _italic_, ~strike~, code fences) is left
// exactly as typed: the point of the relay is to carry the person's words,
// not to re-typeset them.

export interface SlackTextOptions {
  /** This app's own bot user id; its mention is removed, not rendered. */
  botUserId?: string;
}

// Slack entities are `<...>` with a leading @ / # / ! or a URL scheme; an
// optional `|label` carries the display text. Anything else in angle
// brackets (a person typing `<not-a-link>`) is not an entity and is left alone.
const BOT_MENTION_RE = (botUserId: string): RegExp =>
  new RegExp(`<@${botUserId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?:\\|[^>]*)?>`, "g");
const USER_MENTION_RE = /<@([UW][A-Z0-9]+)(?:\|([^>]*))?>/g;
const CHANNEL_RE = /<#([CG][A-Z0-9]+)(?:\|([^>]*))?>/g;
const SUBTEAM_RE = /<!subteam\^[A-Z0-9]+(?:\|([^>]*))?>/g;
const SPECIAL_RE = /<!(here|channel|everyone)(?:\|[^>]*)?>/g;
const DATE_RE = /<!date\^[^|>]*\|([^>]*)>/g;
const LINK_RE = /<((?:https?|mailto|tel):[^|>\s]+)(?:\|([^>]*))?>/g;

/** Renders Slack message text as Markdown. See the module comment for scope. */
export function slackTextToMarkdown(text: string, options: SlackTextOptions): string {
  let out = text;
  if (options.botUserId) out = out.replace(BOT_MENTION_RE(options.botUserId), "");
  out = out.replace(SUBTEAM_RE, (_m, label?: string) => (label ? label : "@team"));
  out = out.replace(SPECIAL_RE, (_m, keyword: string) => `@${keyword}`);
  out = out.replace(DATE_RE, (_m, fallback: string) => fallback);
  out = out.replace(CHANNEL_RE, (_m, id: string, name?: string) => (name ? `#${name}` : `#${id}`));
  out = out.replace(USER_MENTION_RE, (_m, id: string, name?: string) => (name ? `@${name}` : `@${id}`));
  out = out.replace(LINK_RE, (_m, url: string, label?: string) =>
    label && label !== url ? `[${label}](${url})` : url,
  );
  // Last, so an unescaped `<` or `&` can never be re-read as an entity above.
  out = out.replaceAll("&lt;", "<").replaceAll("&gt;", ">").replaceAll("&amp;", "&");
  return out.trim();
}
