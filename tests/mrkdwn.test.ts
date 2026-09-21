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

  it("converts an http:// link", () => {
    expect(markdownToMrkdwn("[link](http://x.example)")).toBe("<http://x.example|link>");
  });

  it("converts a mailto: link", () => {
    expect(markdownToMrkdwn("[email me](mailto:someone@example.com)")).toBe(
      "<mailto:someone@example.com|email me>",
    );
  });

  it("matches the scheme case-insensitively", () => {
    expect(markdownToMrkdwn("[link](HTTPS://ok.example)")).toBe("<HTTPS://ok.example|link>");
  });

  it("does not convert a link whose destination is not a safe URL scheme, to avoid mass-pings", () => {
    expect(markdownToMrkdwn("[x](!channel)")).not.toContain("<");
    expect(markdownToMrkdwn("[status](!subteam^S01ABCDEF)")).not.toContain("<");
    expect(markdownToMrkdwn("[x](@U024BE7LH)")).not.toContain("<");
    expect(markdownToMrkdwn("[x](#C024BE7LR)")).not.toContain("<");
  });

  it("does not convert an image whose destination is not a safe URL scheme, to avoid mass-pings", () => {
    expect(markdownToMrkdwn("![x](!here)")).not.toContain("<");
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

  describe("fidelity pack", () => {
    it("converts single-star italic *x* to Slack italic _x_", () => {
      expect(markdownToMrkdwn("an *emphasised* word")).toBe("an _emphasised_ word");
    });

    it("leaves spaced-out stars alone — 'a * b * c' is arithmetic, not emphasis", () => {
      expect(markdownToMrkdwn("a * b * c")).toBe("a * b * c");
    });

    it("converts bold-italic ***x*** to Slack *_x_*", () => {
      expect(markdownToMrkdwn("***really***")).toBe("*_really_*");
    });

    it("inserts U+200B before the closing bold star when the content ends with a non-word character", () => {
      // Slack's parser fails to close bold when * follows ), ], ., : etc,
      // silently truncating the rest of the message.
      expect(markdownToMrkdwn("**verified (2/4)**")).toBe("*verified (2/4)\u200B*");
    });

    it("does not insert U+200B when bold content ends with a word character", () => {
      expect(markdownToMrkdwn("**word**")).toBe("*word*");
    });

    it("keeps converted bold out of the italic pass", () => {
      expect(markdownToMrkdwn("**x** and __y__")).toBe("*x* and *y*");
    });

    it("restores nested inline code inside converted bold", () => {
      expect(markdownToMrkdwn("**bold `code` end**")).toBe("*bold `code` end*");
    });

    it("strips the language tag from a genuine opening fence — Slack renders it as a literal first line", () => {
      expect(markdownToMrkdwn("```python\nprint(1)\n```")).toBe("```\nprint(1)\n```");
    });

    it("keeps an untagged fence unchanged", () => {
      expect(markdownToMrkdwn("```\nx\n```")).toBe("```\nx\n```");
    });

    it("does not strip content after a mid-line triple backtick, which is not an opening fence", () => {
      expect(markdownToMrkdwn("see ```inline span``` here")).toBe("see ```inline span``` here");
    });

    it("converts a link whose URL contains balanced parentheses", () => {
      expect(markdownToMrkdwn("[Foo](https://en.wikipedia.org/wiki/Foo_(bar))")).toBe(
        "<https://en.wikipedia.org/wiki/Foo_(bar)|Foo>",
      );
    });

    it("protects a converted link's URL from the emphasis passes", () => {
      expect(markdownToMrkdwn("[x](https://a.example/b__c__d)")).toBe("<https://a.example/b__c__d|x>");
    });

    it("strips redundant bold markers inside a header instead of nesting them", () => {
      expect(markdownToMrkdwn("# Title **x**")).toBe("*Title x*");
    });
  });
});

describe("pipe tables", () => {
  it("wraps a GFM pipe table in a fence with aligned columns", () => {
    const input = "| Name | Qty |\n|---|---|\n| foo | 1 |\n| barbar | 22 |";
    expect(markdownToMrkdwn(input)).toBe(
      "```\nName   | Qty\n-------|----\nfoo    | 1\nbarbar | 22\n```",
    );
  });

  it("keeps text around the table and converts the rest normally", () => {
    const input = "**intro**\n\n| A | B |\n|---|---|\n| 1 | 2 |\n\nafter";
    const out = markdownToMrkdwn(input);
    expect(out).toContain("*intro*");
    expect(out).toContain("```\nA | B\n--|--\n1 | 2\n```");
    expect(out).toContain("after");
  });

  it("leaves a pipe table inside an existing code fence untouched", () => {
    const input = "```\n| A | B |\n|---|---|\n| 1 | 2 |\n```";
    expect(markdownToMrkdwn(input)).toBe(input);
  });

  it("does not treat a lone pipe line without a separator row as a table", () => {
    expect(markdownToMrkdwn("a | b")).toBe("a | b");
  });

  it("keeps markdown inside table cells literal — the fence makes it monospace, not rendered", () => {
    const input = "| H |\n|---|\n| **bold** |";
    const out = markdownToMrkdwn(input);
    expect(out).toContain("**bold**");
    expect(out).not.toContain("*bold*\n");
  });

  it("pads short rows to the header's column count", () => {
    const input = "| A | B |\n|---|---|\n| only |";
    expect(markdownToMrkdwn(input)).toBe("```\nA    | B\n-----|--\nonly |\n```");
  });
});
