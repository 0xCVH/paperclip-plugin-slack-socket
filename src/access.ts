// Pure access-control check for the Slack user allowlist (see
// `allowedSlackUserIds` in types.ts / constants.ts / manifest.ts). Kept
// separate from worker.ts so it's trivially unit-testable without any
// plugin context or gateway plumbing.

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
  const normalized = allowlist.map((id) => id.trim().toLowerCase()).filter((id) => id.length > 0);
  if (normalized.length === 0) return true;

  const trimmedUser = userId.trim().toLowerCase();
  if (trimmedUser.length === 0) return false;

  return normalized.includes(trimmedUser);
}
