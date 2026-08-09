// One entity id -> the one Slack message we posted for it. "Post a message,
// remember {channel, ts} against an entity id, update it later, prune it."
// notifications.ts has done this inline for issue threads since day one and
// approvals.ts is now the second caller, so the pattern lives here rather
// than being copied a third time.
//
// Index maintenance goes through updateIndex (state-index.ts) rather than a
// bare get/set so two concurrent links can't lose each other's append.
import type { PluginContext } from "@paperclipai/plugin-sdk";
import { stateScope } from "./constants.js";
import { updateIndex } from "./state-index.js";
import type { MessageLink } from "./types.js";

export type { MessageLink };

/**
 * Records that `posted` is the Slack message representing `key`'s entity and
 * adds `key` to `indexKey`'s membership list so the cleanup job can find it.
 */
export async function linkMessage(
  ctx: PluginContext,
  indexKey: string,
  key: string,
  posted: { channel: string; ts: string },
): Promise<void> {
  const entry: MessageLink = {
    channel: posted.channel,
    ts: posted.ts,
    createdAt: new Date().toISOString(),
  };
  await ctx.state.set(stateScope(key), entry);
  await updateIndex(ctx, indexKey, (current) => (current.includes(key) ? current : [...current, key]));
}

/** The Slack message linked to `key`, or null when nothing is linked. */
export async function getMessageLink(ctx: PluginContext, key: string): Promise<MessageLink | null> {
  return ((await ctx.state.get(stateScope(key))) as MessageLink | null) ?? null;
}

/** Drops the link for `key` and its index membership. */
export async function unlinkMessage(ctx: PluginContext, indexKey: string, key: string): Promise<void> {
  await ctx.state.delete(stateScope(key));
  await updateIndex(ctx, indexKey, (current) => current.filter((k) => k !== key));
}

/**
 * Deletes links older than `maxAgeMs` and drops index keys whose link has
 * already vanished. `now` is injected so one cleanup pass shares a single
 * clock reading across every index it prunes.
 */
export async function pruneMessageLinks(
  ctx: PluginContext,
  indexKey: string,
  maxAgeMs: number,
  now: number,
): Promise<void> {
  const index = ((await ctx.state.get(stateScope(indexKey))) as string[] | null) ?? [];
  const removed: string[] = [];
  for (const key of index) {
    const entry = (await ctx.state.get(stateScope(key))) as MessageLink | null;
    if (!entry) {
      removed.push(key);
      continue;
    }
    if (now - Date.parse(entry.createdAt) > maxAgeMs) {
      await ctx.state.delete(stateScope(key));
      removed.push(key);
    }
  }
  // Filter the freshly-read index rather than writing `index` back, so a key
  // appended while we were iterating survives.
  await updateIndex(ctx, indexKey, (current) => current.filter((k) => !removed.includes(k)));
}
