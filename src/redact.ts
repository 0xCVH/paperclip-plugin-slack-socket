// Log-redaction safety net: Slack bot/app tokens should never reach logs in
// the first place, but errors thrown by the Slack SDK sometimes echo back
// request details (including a token) in their message. Scrub known Slack
// token shapes before any error ever reaches a logger call.

const BOT_TOKEN_PATTERN = /xox[a-z]-[A-Za-z0-9-]+/gi;
const APP_TOKEN_PATTERN = /xapp-[A-Za-z0-9-]+/gi;

export function redactSecrets(s: string): string {
  return s.replace(BOT_TOKEN_PATTERN, "[REDACTED]").replace(APP_TOKEN_PATTERN, "[REDACTED]");
}

/** String(err), with any Slack tokens in the result redacted. */
export function errString(err: unknown): string {
  return redactSecrets(String(err));
}
