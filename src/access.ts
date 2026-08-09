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

/** Decision returned by `checkToolCompany`. */
export type ToolCompanyDecision = { allowed: true } | { allowed: false; reason: string };

/**
 * Decides whether a tool invocation may act on this worker's behalf, given the
 * company the worker's config is bound to and the company of the agent run
 * that called the tool.
 *
 * This worker process is single-tenant (see the module-level comments in
 * worker.ts around `boundCompanyId`), but that binding is enforced only where
 * config changes are applied — nothing stops the host from routing an
 * invocation for a *different* company's agent run into this same process.
 * Without this check, that run would be authorized against the bound company's
 * config and would reach the bound company's Slack workspace using the bound
 * company's bot token.
 *
 * Both tool call sites share this one function precisely because a security
 * check duplicated by hand is a security check that drifts.
 *
 * `reason` deliberately names only the action, never the bound company: the
 * string is handed straight back to a caller we have just established belongs
 * to a *different* tenant, so it must not leak which company this process
 * serves.
 *
 * A blank `configCompanyId` means the worker is not bound yet (that is
 * `DEFAULT_CONFIG.companyId`, returned by `getLiveConfig()` before any config
 * arrives). It fails closed rather than matching a blank run company.
 */
export function checkToolCompany(
  configCompanyId: string,
  runCompanyId: string,
  actionLabel: string,
): ToolCompanyDecision {
  const refused: ToolCompanyDecision = {
    allowed: false,
    reason: `${actionLabel} is not authorized for this company.`,
  };
  if (configCompanyId.trim().length === 0) return refused;
  if (runCompanyId !== configCompanyId) return refused;
  return { allowed: true };
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
