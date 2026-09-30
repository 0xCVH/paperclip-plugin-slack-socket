import { describe, expect, it } from "vitest";
import { slackTextToMarkdown } from "../src/slack-markdown.js";

// The relay writes a person's Slack words onto a Paperclip issue, where
// they are rendered as Markdown. Slack's mrkdwn entities (<url|label>,
// <@U…>, <#C…|name>, <!here>, HTML-escaped &, <, >) would otherwise land
// on the issue as raw angle-bracket noise.
describe("slackTextToMarkdown", () => {
  it("strips the bot's own mention and trims", () => {
    expect(slackTextToMarkdown("<@UBOT> please note this", { botUserId: "UBOT" })).toBe("please note this");
    expect(slackTextToMarkdown("  hello <@UBOT>  ", { botUserId: "UBOT" })).toBe("hello");
  });

  it("keeps other people's mentions as @ids rather than dropping them", () => {
    expect(slackTextToMarkdown("<@U04T8P39TCM> can you confirm?", { botUserId: "UBOT" })).toBe(
      "@U04T8P39TCM can you confirm?",
    );
  });

  it("turns labelled links into Markdown links and bare links into plain URLs", () => {
    expect(
      slackTextToMarkdown("the fix was <https://github.com/0xPolygon/onchain-monitoring/pull/53|PR #53>", {}),
    ).toBe("the fix was [PR #53](https://github.com/0xPolygon/onchain-monitoring/pull/53)");
    expect(slackTextToMarkdown("see <https://example.com/a?b=1>", {})).toBe("see https://example.com/a?b=1");
  });

  it("renders channel links and broadcast keywords as their visible text", () => {
    expect(slackTextToMarkdown("posted in <#C0BMM03E66A|security-alerts>", {})).toBe("posted in #security-alerts");
    expect(slackTextToMarkdown("<!here> <!channel> <!subteam^S123|@blockops>", {})).toBe("@here @channel @blockops");
  });

  it("unescapes the HTML entities Slack encodes", () => {
    expect(slackTextToMarkdown("a &amp; b &lt; c &gt; d", {})).toBe("a & b < c > d");
  });

  it("leaves ordinary text, line breaks and code untouched", () => {
    const text = "line one\nline two\n```\ncode <not-a-link>\n```";
    expect(slackTextToMarkdown(text, {})).toBe(text);
  });
});

describe("slackTextToMarkdown: link honesty", () => {
  it("escapes brackets in a label so the label cannot close the link early and point elsewhere", () => {
    expect(slackTextToMarkdown("<https://real.example/|a](https://evil.example) b>", {})).toBe(
      "[a\\](https://evil.example) b](https://real.example/)",
    );
  });

  it("shows the real destination beside a label that itself looks like a URL", () => {
    expect(slackTextToMarkdown("<https://evil.example/x|https://github.com/0xPolygon/pull/53>", {})).toBe(
      "https://github.com/0xPolygon/pull/53 (https://evil.example/x)",
    );
    expect(slackTextToMarkdown("<https://evil.example/x|www.github.com>", {})).toBe("www.github.com (https://evil.example/x)");
  });
});
