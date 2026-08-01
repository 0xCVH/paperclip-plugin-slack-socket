import { DEFAULT_CONFIG } from "./constants.js";
import type { SlackSocketConfig } from "./types.js";

/**
 * Merge a raw, host-supplied config object over DEFAULT_CONFIG.
 *
 * Pure and side-effect free — used both by `onConfigChanged` (to build the
 * cached live config from the host's push) and `onValidateConfig` (to build
 * the config being validated from its own input argument). Neither call may
 * fall back to `ctx.config.get()`: this plugin is "proactive" — its work
 * happens in Socket Mode callbacks, timers, and `setup()`, never inside a
 * host-issued invocation — and outside an invocation the host can only
 * resolve company scope from an explicit `companyId`, which `config.get()`
 * doesn't have a way to supply here.
 */
export function mergeConfig(raw: unknown): SlackSocketConfig {
  return { ...DEFAULT_CONFIG, ...(raw as Partial<SlackSocketConfig>) };
}
