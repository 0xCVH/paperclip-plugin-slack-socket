import { describe, expect, it } from "vitest";
import {
  escapeMrkdwn,
  formatAgentRunFailed,
  formatApprovalCreated,
  formatApprovalDecided,
  formatIssueCreated,
  formatIssueDone,
  formatQuestion,
  formatQuestionExpired,
  formatQuestionResolved,
} from "../src/formatters.js";
import { ACTION_IDS } from "../src/constants.js";

const BASE = "https://pc.example";

describe("formatters", () => {
  it("issue created includes title and dashboard link", () => {
    const out = formatIssueCreated({ title: "Fix login", status: "todo" }, "iss-1", BASE);
    const json = JSON.stringify(out.blocks);
    expect(out.text).toContain("Fix login");
    expect(json).toContain(`${BASE}/issues/iss-1`);
  });

  it("issue done falls back to issue id when payload has no title", () => {
    const out = formatIssueDone(null, "iss-2", BASE);
    expect(out.text).toContain("iss-2");
  });

  it("agent run failed shows the error in a code block", () => {
    const out = formatAgentRunFailed({ error: "boom" });
    expect(JSON.stringify(out.blocks)).toContain("boom");
  });

  it("approval created carries approve and reject buttons with the approval id as value", () => {
    const out = formatApprovalCreated("app-1", { title: "Deploy?" }, BASE);
    const json = JSON.stringify(out.blocks);
    expect(json).toContain(ACTION_IDS.approvalApprove);
    expect(json).toContain(ACTION_IDS.approvalReject);
    expect(json).toContain('"app-1"');
  });

  it("approval decided names the decider and decision", () => {
    const approved = formatApprovalDecided("app-1", "approve", "Sam");
    const rejected = formatApprovalDecided("app-1", "reject", "Sam");
    expect(approved.text).toContain("Approved");
    expect(rejected.text).toContain("Rejected");
    expect(approved.text).toContain("Sam");
  });

  it("question prompts differ by mode", () => {
    const reaction = JSON.stringify(formatQuestion("Ship it?", "reaction").blocks);
    const answer = JSON.stringify(formatQuestion("Ship it?", "answer").blocks);
    expect(reaction.toLowerCase()).toContain("react");
    expect(answer.toLowerCase()).toContain("reply in this thread");
  });

  it("question resolved and expired reference the question", () => {
    expect(formatQuestionResolved("Ship it?", ":+1:", "Sam").text).toContain("Sam");
    expect(formatQuestionExpired("Ship it?").text.toLowerCase()).toContain("expired");
  });

  it("escapeMrkdwn escapes &, <, > and nothing else", () => {
    expect(escapeMrkdwn("a & b < c > d")).toBe("a &amp; b &lt; c &gt; d");
    expect(escapeMrkdwn("plain text")).toBe("plain text");
  });

  it("escapes a hostile title so it can't inject a fake link label", () => {
    const hostile = "<https://evil.example|x>";
    const out = formatIssueCreated({ title: hostile }, "iss-1", BASE);
    const json = JSON.stringify(out.blocks);
    // The raw hostile string must never appear verbatim — its "<" would open
    // a second, attacker-controlled link inside our link's label position.
    expect(json).not.toContain(hostile);
    expect(json).toContain("&lt;https://evil.example|x&gt;");
    expect(out.text).toContain("&lt;https://evil.example|x&gt;");
  });

  it("plain titles are unaffected by escaping", () => {
    const out = formatIssueCreated({ title: "Fix login", status: "todo" }, "iss-1", BASE);
    expect(out.text).toBe("New issue created: Fix login");
  });

  it("escapes question, response, and responder name in a resolved answer", () => {
    const out = formatQuestionResolved("Ship <it>?", "yes & go", "Sam <Admin>");
    const json = JSON.stringify(out.blocks);
    expect(json).toContain("Ship &lt;it&gt;?");
    expect(json).toContain("yes &amp; go");
    expect(json).toContain("Sam &lt;Admin&gt;");
  });
});
