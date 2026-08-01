import { describe, expect, it } from "vitest";
import { markdownToMrkdwn } from "../src/mrkdwn.js";

describe("markdownToMrkdwn", () => {
  it("converts bold **x** and __x__ to *x*", () => {
    expect(markdownToMrkdwn("**bold**")).toBe("*bold*");
    expect(markdownToMrkdwn("__bold__")).toBe("*bold*");
  });

  it("converts a header line to a bold line", () => {
    expect(markdownToMrkdwn("# Title")).toBe("*Title*");
    expect(markdownToMrkdwn("### Sub heading")).toBe("*Sub heading*");
  });

  it("converts a link to Slack's <url|text> syntax", () => {
    expect(markdownToMrkdwn("[link](https://x.example)")).toBe("<https://x.example|link>");
  });

  it("converts an image to Slack's <url|alt> syntax", () => {
    expect(markdownToMrkdwn("![alt text](https://x.example/pic.png)")).toBe(
      "<https://x.example/pic.png|alt text>",
    );
  });

  it("converts strikethrough ~~x~~ to ~x~", () => {
    expect(markdownToMrkdwn("~~gone~~")).toBe("~gone~");
  });

  it("converts leading list markers to bullets", () => {
    expect(markdownToMrkdwn("- one\n* two")).toBe("• one\n• two");
  });

  it("leaves blockquotes and existing Slack entities alone", () => {
    expect(markdownToMrkdwn("> quoted text")).toBe("> quoted text");
    expect(markdownToMrkdwn("<https://x.example|already slack>")).toBe("<https://x.example|already slack>");
  });

  it("protects fenced code blocks from conversion", () => {
    const input = "before\n```\n**not bold** # not a header\n```\nafter";
    const result = markdownToMrkdwn(input);
    expect(result).toContain("```\n**not bold** # not a header\n```");
  });

  it("protects inline code spans from conversion", () => {
    expect(markdownToMrkdwn("use `**not bold**` here")).toBe("use `**not bold**` here");
  });

  it("converts markdown outside a fenced block while leaving the block itself literal", () => {
    const input = "**bold outside**\n```\n**literal inside**\n```";
    const result = markdownToMrkdwn(input);
    expect(result).toContain("*bold outside*");
    expect(result).toContain("**literal inside**");
  });
});
