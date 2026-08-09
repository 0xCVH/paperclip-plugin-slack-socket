import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { checkPostTarget, checkToolCompany, isUserAllowed } from "../src/access.js";
import type { SlackSocketConfig } from "../src/types.js";
import { DEFAULT_CONFIG } from "../src/constants.js";

describe("isUserAllowed", () => {
  it("allows everyone when the allowlist is empty", () => {
    expect(isUserAllowed([], "U-ANY")).toBe(true);
  });

  it("allows everyone when the allowlist contains only blank entries", () => {
    expect(isUserAllowed(["", "   ", "\t"], "U-ANY")).toBe(true);
  });

  it("allows an exact match", () => {
    expect(isUserAllowed(["U-ALLOWED"], "U-ALLOWED")).toBe(true);
  });

  it("allows a match that differs only by case and surrounding whitespace", () => {
    expect(isUserAllowed(["  U-Allowed  "], "u-allowed")).toBe(true);
    expect(isUserAllowed(["u-allowed"], "  U-ALLOWED  ")).toBe(true);
  });

  it("denies a user not present in a non-empty allowlist", () => {
    expect(isUserAllowed(["U-ALLOWED"], "U-OTHER")).toBe(false);
  });

  it("denies a blank/whitespace-only userId against a non-empty allowlist", () => {
    expect(isUserAllowed(["U-ALLOWED"], "")).toBe(false);
    expect(isUserAllowed(["U-ALLOWED"], "   ")).toBe(false);
  });
});

const postConfig = (overrides: Partial<SlackSocketConfig> = {}): SlackSocketConfig => ({
  ...DEFAULT_CONFIG,
  agentPostMessageEnabled: true,
  agentPostToChannelsEnabled: true,
  agentPostChannelIds: ["C-OK"],
  agentDmEnabled: true,
  agentDmUserIds: ["U-OK"],
  ...overrides,
});

describe("checkPostTarget", () => {
  it("refuses everything when the master switch is off", () => {
    const cfg = postConfig({ agentPostMessageEnabled: false });
    expect(checkPostTarget(cfg, "C-OK").allowed).toBe(false);
    expect(checkPostTarget(cfg, "U-OK").allowed).toBe(false);
  });

  it("allows a listed channel", () => {
    expect(checkPostTarget(postConfig(), "C-OK")).toEqual({
      allowed: true, kind: "channel", target: "C-OK",
    });
  });

  it("refuses an unlisted channel", () => {
    const decision = checkPostTarget(postConfig(), "C-OTHER");
    expect(decision.allowed).toBe(false);
    expect(decision.allowed === false && decision.reason).toContain("agentPostChannelIds");
  });

  it("refuses every channel when the list is empty", () => {
    expect(checkPostTarget(postConfig({ agentPostChannelIds: [] }), "C-OK").allowed).toBe(false);
  });

  it("refuses every channel when the list holds only blank entries", () => {
    expect(checkPostTarget(postConfig({ agentPostChannelIds: ["", "  "] }), "C-OK").allowed).toBe(false);
  });

  it("refuses channels when channel posting is switched off", () => {
    expect(checkPostTarget(postConfig({ agentPostToChannelsEnabled: false }), "C-OK").allowed).toBe(false);
  });

  it("allows a listed user as a dm", () => {
    expect(checkPostTarget(postConfig(), "U-OK")).toEqual({
      allowed: true, kind: "dm", target: "U-OK",
    });
  });

  it("treats an Enterprise Grid W-prefixed id as a dm", () => {
    expect(checkPostTarget(postConfig({ agentDmUserIds: ["W-OK"] }), "W-OK")).toEqual({
      allowed: true, kind: "dm", target: "W-OK",
    });
  });

  it("refuses an unlisted user", () => {
    const decision = checkPostTarget(postConfig(), "U-OTHER");
    expect(decision.allowed).toBe(false);
    expect(decision.allowed === false && decision.reason).toContain("agentDmUserIds");
  });

  it("refuses every dm when the list is empty", () => {
    expect(checkPostTarget(postConfig({ agentDmUserIds: [] }), "U-OK").allowed).toBe(false);
  });

  it("refuses dms when dm sending is switched off", () => {
    expect(checkPostTarget(postConfig({ agentDmEnabled: false }), "U-OK").allowed).toBe(false);
  });

  it("allows any user when agentDmAnyUser is on", () => {
    const cfg = postConfig({ agentDmUserIds: [], agentDmAnyUser: true });
    expect(checkPostTarget(cfg, "U-STRANGER")).toEqual({
      allowed: true, kind: "dm", target: "U-STRANGER",
    });
  });

  it("still refuses dms when agentDmAnyUser is on but dm sending is off", () => {
    const cfg = postConfig({ agentDmAnyUser: true, agentDmEnabled: false });
    expect(checkPostTarget(cfg, "U-STRANGER").allowed).toBe(false);
  });

  it("matches trimmed and case-insensitively, and returns the trimmed target", () => {
    const cfg = postConfig({ agentPostChannelIds: ["  c-ok  "] });
    expect(checkPostTarget(cfg, "  C-OK  ")).toEqual({
      allowed: true, kind: "channel", target: "C-OK",
    });
  });

  it("refuses a blank target", () => {
    expect(checkPostTarget(postConfig(), "   ").allowed).toBe(false);
  });

  it("never authorizes a user id listed in the channel list", () => {
    const cfg = postConfig({ agentPostChannelIds: ["U-OK"], agentDmUserIds: [] });
    expect(checkPostTarget(cfg, "U-OK").allowed).toBe(false);
  });
});

describe("checkToolCompany", () => {
  it("allows a run whose company matches the bound config", () => {
    expect(checkToolCompany("co-1", "co-1", "Posting to Slack")).toEqual({ allowed: true });
  });

  it("refuses a run from a different company", () => {
    const decision = checkToolCompany("co-1", "co-2", "Posting to Slack");
    expect(decision.allowed).toBe(false);
    expect(decision.allowed === false && decision.reason).toBe("Posting to Slack is not authorized for this company.");
  });

  it("builds the refusal from the action label it is given", () => {
    const decision = checkToolCompany("co-1", "co-2", "Asking a human via Slack");
    expect(decision.allowed === false && decision.reason).toBe(
      "Asking a human via Slack is not authorized for this company.",
    );
  });

  it("never names the bound company in the refusal", () => {
    // The reason string is handed straight back to a caller we have just
    // established belongs to a different tenant, so it must not disclose
    // which company this worker serves.
    for (const label of ["Posting to Slack", "Asking a human via Slack"]) {
      const decision = checkToolCompany("co-secret-tenant", "co-intruder", label);
      expect(decision.allowed).toBe(false);
      expect(decision.allowed === false && decision.reason).not.toContain("co-secret-tenant");
    }
  });

  it("fails closed when the worker is not bound to a company yet", () => {
    // getLiveConfig() returns DEFAULT_CONFIG (companyId "") before any
    // config arrives; a blank bound company must never match a blank run.
    expect(checkToolCompany(DEFAULT_CONFIG.companyId, "", "Posting to Slack").allowed).toBe(false);
    expect(checkToolCompany("   ", "   ", "Posting to Slack").allowed).toBe(false);
    expect(checkToolCompany("", "co-1", "Posting to Slack").allowed).toBe(false);
  });

  it("compares exactly — no trimming or case folding of a real company id", () => {
    expect(checkToolCompany("co-1", "CO-1", "Posting to Slack").allowed).toBe(false);
    expect(checkToolCompany("co-1", " co-1 ", "Posting to Slack").allowed).toBe(false);
  });
});

describe("access.ts purity", () => {
  it("imports no plugin context, gateway or state plumbing", () => {
    // The spec pins access.ts as the pure-decision module: it takes no ctx
    // so every decision here stays trivially unit-testable, and so a
    // security check can never quietly grow an I/O dependency. Logging and
    // refusal metrics belong at the call sites.
    const source = readFileSync(new URL("../src/access.ts", import.meta.url), "utf8");
    expect(source).not.toContain("@paperclipai/plugin-sdk");
    expect(source).not.toContain("PluginContext");
    expect(source).not.toContain("SlackGateway");
  });
});
