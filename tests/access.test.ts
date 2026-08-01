import { describe, expect, it } from "vitest";
import { isUserAllowed } from "../src/access.js";

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
