import { describe, expect, it } from "vitest";
import manifest from "../src/manifest.js";
import { JOB_KEYS, TOOL_NAMES } from "../src/constants.js";

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

  it("declares the cleanup job and the ask_human tool", () => {
    expect(manifest.jobs?.map((j) => j.jobKey)).toEqual([JOB_KEYS.cleanup]);
    expect(manifest.tools?.map((t) => t.name)).toEqual([TOOL_NAMES.askHuman]);
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
});
