import type { PluginContext } from "@paperclipai/plugin-sdk";
import { DEFAULT_CONFIG } from "./constants.js";
import type { SlackSocketConfig } from "./types.js";

export async function loadConfig(ctx: PluginContext): Promise<SlackSocketConfig> {
  const raw = await ctx.config.get();
  return { ...DEFAULT_CONFIG, ...(raw as Partial<SlackSocketConfig>) };
}
