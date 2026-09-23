import { describe, expect, it } from "vitest";
import { MAX_MESSAGE_LENGTH, splitIntoChunks } from "../src/slack-text.js";

describe("splitIntoChunks", () => {
  it("returns the text unchanged as a single chunk when it fits — no part indicator", () => {
    expect(splitIntoChunks("short", 100)).toEqual(["short"]);
  });

  it("returns [] for empty input", () => {
    expect(splitIntoChunks("", 100)).toEqual([]);
  });

  it("splits at line boundaries and appends part indicators", () => {
    const text = `${"a".repeat(60)}\n${"b".repeat(60)}\n${"c".repeat(60)}`;
    const chunks = splitIntoChunks(text, 100);
    expect(chunks.length).toBeGreaterThan(1);
    for (const [i, chunk] of chunks.entries()) {
      expect(chunk.length).toBeLessThanOrEqual(100);
      expect(chunk).toContain(`_(${i + 1}/${chunks.length})_`);
    }
    // Stripping indicators and rejoining reproduces the original text.
    const rejoined = chunks.map((c) => c.replace(/\n_\(\d+\/\d+\)_$/, "")).join("\n");
    expect(rejoined).toBe(text);
  });

  it("closes an open code fence at a chunk boundary and reopens it in the next chunk", () => {
    const code = Array.from({ length: 20 }, (_, i) => `line ${i} ${"x".repeat(20)}`).join("\n");
    const text = `intro\n\`\`\`\n${code}\n\`\`\`\nafter`;
    const chunks = splitIntoChunks(text, 200);
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      // Balanced fences in every chunk: an odd count renders the rest of
      // the chunk (or the next one) as accidental code/prose.
      const fenceCount = (chunk.match(/^```/gm) ?? []).length;
      expect(fenceCount % 2).toBe(0);
    }
  });

  it("hard-splits a single oversized line without exceeding the size", () => {
    const chunks = splitIntoChunks("z".repeat(9000), MAX_MESSAGE_LENGTH);
    expect(chunks.length).toBeGreaterThan(2);
    for (const chunk of chunks) expect(chunk.length).toBeLessThanOrEqual(MAX_MESSAGE_LENGTH);
    const rejoined = chunks.map((c) => c.replace(/\n_\(\d+\/\d+\)_$/, "")).join("");
    expect(rejoined).toBe("z".repeat(9000));
  });
});
