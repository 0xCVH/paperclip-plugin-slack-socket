// Pure access-control check for the Slack user allowlist (see
// `allowedSlackUserIds` in types.ts / constants.ts / manifest.ts). Kept
// separate from worker.ts so it's trivially unit-testable without any
// plugin context or gateway plumbing.

import type { SlackSocketConfig } from "./types.js";

/** Trim + lowercase every entry and drop the blanks. */
function normalizeList(list: readonly string[]): string[] {
  return list.map((id) => id.trim().toLowerCase()).filter((id) => id.length > 0);
}

/**
 * Returns whether `userId` is permitted to interact with the bot, given
 * `allowlist`.
 *
 * - Both the allowlist entries and `userId` are trimmed and compared
 *   case-insensitively.
 * - Blank/whitespace-only entries in `allowlist` are ignored; if every entry
 *   is blank (or the list is empty), the allowlist is treated as disabled
 *   and everyone is allowed.
 * - A blank/whitespace-only `userId` against a non-empty (post-trim)
 *   allowlist fails closed (returns false) — a missing user id can never
 *   match a real allowlist entry.
 */
export function isUserAllowed(allowlist: readonly string[], userId: string): boolean {
  const normalized = normalizeList(allowlist);
  if (normalized.length === 0) return true;

  const trimmedUser = userId.trim().toLowerCase();
  if (trimmedUser.length === 0) return false;

  return normalized.includes(trimmedUser);
}

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
