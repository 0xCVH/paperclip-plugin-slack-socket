import { describe, expect, it } from "vitest";
import { errString, redactSecrets } from "../src/redact.js";

describe("redactSecrets", () => {
  it("redacts a bot token", () => {
    expect(redactSecrets("token xoxb-123-456-abcDEF")).toBe("token [REDACTED]");
  });

  it("redacts an app token", () => {
    expect(redactSecrets("token xapp-1-A0123-456-abcDEF")).toBe("token [REDACTED]");
  });

  it("redacts multiple tokens mixed into surrounding text", () => {
    const input = "auth failed for xoxb-a-b-c and xapp-1-2-3 during request";
    expect(redactSecrets(input)).toBe("auth failed for [REDACTED] and [REDACTED] during request");
  });

  it("leaves text without tokens unchanged", () => {
    expect(redactSecrets("plain error message")).toBe("plain error message");
  });
});

describe("errString", () => {
  it("stringifies and redacts a non-string input (an Error object)", () => {
    const err = new Error("failed with token xoxb-secret-value");
    expect(errString(err)).toBe("Error: failed with token [REDACTED]");
  });

  it("stringifies a non-Error value", () => {
    expect(errString({ code: "boom" })).toBe("[object Object]");
  });
});
