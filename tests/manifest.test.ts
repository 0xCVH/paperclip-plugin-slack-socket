import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import manifest from "../src/manifest.js";
import { JOB_KEYS, PLUGIN_VERSION, TOOL_NAMES } from "../src/constants.js";

describe("manifest", () => {
  it("declares no webhooks (Socket Mode only)", () => {
    expect(manifest.webhooks ?? []).toHaveLength(0);
  });

  it("declares the exact least-privilege capability set", () => {
    expect([...manifest.capabilities].sort()).toEqual(
      [
        "issues.create", "issue.comments.create", "issues.wakeup",
        "agent.sessions.create", "agent.sessions.send", "agent.sessions.close",
        "agent.tools.register", "http.outbound", "events.subscribe",
        "plugin.state.read", "plugin.state.write", "secrets.read-ref", "instance.settings.register",
        "activity.log.write", "metrics.write", "jobs.schedule",
      ].sort(),
    );
  });

  it("declares the cleanup job and both agent tools", () => {
    expect(manifest.jobs?.map((j) => j.jobKey)).toEqual([JOB_KEYS.cleanup]);
    expect(manifest.tools?.map((t) => t.name)).toEqual([TOOL_NAMES.askHuman, TOOL_NAMES.postMessage]);
  });

  it("requires tokens, company, agent, and default channel in config", () => {
    const schema = manifest.instanceConfigSchema as { required?: string[] };
    expect(schema.required).toEqual([
      "slackBotTokenRef", "slackAppTokenRef", "companyId", "defaultAgentId", "defaultChannelId",
    ]);
  });

  it("declares the optional Paperclip board API key secret ref, not required", () => {
    const schema = manifest.instanceConfigSchema as {
      required?: string[];
      properties: Record<string, { format?: string; default?: unknown }>;
    };
    expect(schema.properties.paperclipApiKeyRef).toMatchObject({ format: "secret-ref", default: "" });
    expect(schema.required).not.toContain("paperclipApiKeyRef");
  });

  it("keeps the manifest version and package.json version in lockstep", () => {
    // The host reads the version from the manifest and operators read it from
    // npm; letting the two drift ships a build that misreports itself. Read
    // via node:fs rather than a JSON import because tsconfig.json does not
    // enable resolveJsonModule.
    const pkg = JSON.parse(
      readFileSync(new URL("../package.json", import.meta.url), "utf8"),
    ) as { version: string };
    expect(manifest.version).toBe(PLUGIN_VERSION);
    expect(PLUGIN_VERSION).toBe(pkg.version);
  });
});

describe("slack-app-manifest drift", () => {
  it("keeps REQUIRED_BOT_SCOPES in lockstep with the checked-in Slack app manifest", async () => {
    const { readFile } = await import("node:fs/promises");
    const { REQUIRED_BOT_SCOPES } = await import("../src/constants.js");
    const manifest = JSON.parse(await readFile(new URL("../slack-app-manifest.json", import.meta.url), "utf8")) as {
      oauth_config: { scopes: { bot: string[] } };
    };
    expect([...REQUIRED_BOT_SCOPES].sort()).toEqual([...manifest.oauth_config.scopes.bot].sort());
  });
});
