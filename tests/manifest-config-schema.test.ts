import { describe, expect, it } from "vitest";
import Ajv, { type ErrorObject } from "ajv";
import addFormats from "ajv-formats";
import manifest from "../src/manifest.js";

// Mirrors the host's server/src/services/plugin-config-validator.ts so these
// tests fail here rather than as a 400 from PUT /api/plugins/:id/config.
function validateInstanceConfig(configJson: Record<string, unknown>): {
  valid: boolean;
  errors: { field: string; message: string }[];
} {
  // The host resolves both interop shapes the same way; mirror it so this
  // test exercises the code path the server actually runs.
  // Ajv and ajv-formats ship dual CJS/ESM entry points whose default export
  // lands differently depending on the loader, so both are resolved the same
  // way the host does before use.
  interface AjvLike {
    addFormat(name: string, definition: { validate: () => boolean }): void;
    compile(schema: object): ((data: unknown) => boolean) & { errors?: ErrorObject[] | null };
  }
  type AjvCtorLike = new (options: { allErrors: boolean }) => AjvLike;
  type ApplyFormats = (ajv: AjvLike) => unknown;

  const AjvCtor = ((Ajv as unknown as { default?: unknown }).default ??
    Ajv) as unknown as AjvCtorLike;
  const applyFormats = ((addFormats as unknown as { default?: unknown }).default ??
    addFormats) as unknown as ApplyFormats;

  const ajv = new AjvCtor({ allErrors: true });
  applyFormats(ajv);
  ajv.addFormat("secret-ref", { validate: () => true });
  const validate = ajv.compile(manifest.instanceConfigSchema as object);
  const valid = validate(configJson) as boolean;
  return {
    valid,
    errors: (validate.errors ?? []).map((err: ErrorObject) => ({
      field: err.instancePath || "/",
      message: err.message ?? "validation failed",
    })),
  };
}

const SECRET_REF = {
  type: "secret_ref",
  secretId: "11111111-1111-4111-8111-111111111111",
  version: "latest",
};

const baseConfig = {
  companyId: "33333333-3333-4333-8333-333333333333",
  defaultAgentId: "44444444-4444-4444-8444-444444444444",
  defaultChannelId: "C01ABC2DEF3",
};

describe("instanceConfigSchema vs the host settings form", () => {
  it("accepts the secret_ref objects the host's secret picker stores", () => {
    const result = validateInstanceConfig({
      ...baseConfig,
      slackBotTokenRef: SECRET_REF,
      slackAppTokenRef: SECRET_REF,
    });
    expect(result.errors).toEqual([]);
    expect(result.valid).toBe(true);
  });

  it("accepts a numeric version selector on a secret ref", () => {
    const result = validateInstanceConfig({
      ...baseConfig,
      slackBotTokenRef: { type: "secret_ref", secretId: SECRET_REF.secretId, version: 3 },
      slackAppTokenRef: SECRET_REF,
    });
    expect(result.valid).toBe(true);
  });

  it("accepts the optional board API key as a secret_ref object", () => {
    const result = validateInstanceConfig({
      ...baseConfig,
      slackBotTokenRef: SECRET_REF,
      slackAppTokenRef: SECRET_REF,
      paperclipApiKeyRef: SECRET_REF,
    });
    expect(result.valid).toBe(true);
  });

  it("still accepts plain-string refs from the raw-input path", () => {
    const result = validateInstanceConfig({
      ...baseConfig,
      slackBotTokenRef: SECRET_REF.secretId,
      slackAppTokenRef: SECRET_REF.secretId,
    });
    expect(result.valid).toBe(true);
  });

  it("accepts a fully populated config with every optional field set", () => {
    const result = validateInstanceConfig({
      ...baseConfig,
      slackBotTokenRef: SECRET_REF,
      slackAppTokenRef: SECRET_REF,
      paperclipApiKeyRef: SECRET_REF,
      notifyOnIssueCreated: true,
      notifyOnIssueDone: false,
      notifyOnAgentRunFailed: true,
      notifyOnApprovalCreated: false,
      issuesChannelId: "C-ISSUES",
      errorsChannelId: "C-ERR",
      approvalsChannelId: "C-APPR",
      paperclipBaseUrl: "http://localhost:3100",
      sessionIdleHours: 12,
    });
    expect(result.valid).toBe(true);
  });

  it("still rejects a config missing required fields", () => {
    const result = validateInstanceConfig({ slackBotTokenRef: SECRET_REF });
    expect(result.valid).toBe(false);
    expect(result.errors.map((e) => e.message).join(" ")).toContain("required");
  });

  it("still rejects wrong scalar types", () => {
    const result = validateInstanceConfig({
      ...baseConfig,
      slackBotTokenRef: SECRET_REF,
      slackAppTokenRef: SECRET_REF,
      sessionIdleHours: "24",
    });
    expect(result.valid).toBe(false);
    expect(result.errors).toContainEqual({ field: "/sessionIdleHours", message: "must be number" });
  });

  it("accepts the agent-posting fields the settings form stores", () => {
    const result = validateInstanceConfig({
      ...baseConfig,
      slackBotTokenRef: SECRET_REF,
      slackAppTokenRef: SECRET_REF,
      agentPostMessageEnabled: true,
      agentPostToChannelsEnabled: true,
      agentPostChannelIds: ["C01ABC2DEF3", "C09XYZ8GHI7"],
      agentDmEnabled: true,
      agentDmUserIds: ["U01ABC2DEF3"],
      agentDmAnyUser: false,
    });
    expect(result.errors).toEqual([]);
    expect(result.valid).toBe(true);
  });

  it("rejects a non-array agentPostChannelIds", () => {
    const result = validateInstanceConfig({
      ...baseConfig,
      slackBotTokenRef: SECRET_REF,
      slackAppTokenRef: SECRET_REF,
      agentPostChannelIds: "C01ABC2DEF3",
    });
    expect(result.valid).toBe(false);
  });

  it("defaults every agent-posting field to its safe value", () => {
    const schema = manifest.instanceConfigSchema as {
      properties: Record<string, { default?: unknown }>;
    };
    expect(schema.properties.agentPostMessageEnabled?.default).toBe(false);
    expect(schema.properties.agentPostToChannelsEnabled?.default).toBe(false);
    expect(schema.properties.agentPostChannelIds?.default).toEqual([]);
    expect(schema.properties.agentDmEnabled?.default).toBe(false);
    expect(schema.properties.agentDmUserIds?.default).toEqual([]);
    expect(schema.properties.agentDmAnyUser?.default).toBe(false);
  });
});
