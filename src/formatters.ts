import { ACTION_IDS } from "./constants.js";
import type { QuestionMode } from "./types.js";

export interface SlackContent {
  text: string;
  blocks: unknown[];
}

type Payload = Record<string, unknown> | null | undefined;

const section = (text: string) => ({ type: "section", text: { type: "mrkdwn", text } });
const context = (text: string) => ({ type: "context", elements: [{ type: "mrkdwn", text }] });

function str(payload: Payload, key: string): string {
  const value = payload?.[key];
  return typeof value === "string" ? value : "";
}

/**
 * Escapes Slack mrkdwn's three special characters in a string that comes
 * from plugin/event payload data or a Slack user profile — i.e. anything we
 * didn't author ourselves. Must NOT be applied to our own literal markup
 * (section/context text templates, emoji codes, link syntax we construct).
 * See https://api.slack.com/reference/surfaces/formatting#escaping
 */
export function escapeMrkdwn(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export function formatIssueCreated(payload: Payload, issueId: string, baseUrl: string): SlackContent {
  const title = escapeMrkdwn(str(payload, "title") || issueId);
  const status = escapeMrkdwn(str(payload, "status") || "todo");
  const priority = escapeMrkdwn(str(payload, "priority"));
  const meta = [`Status: ${status}`, priority ? `Priority: ${priority}` : ""].filter(Boolean).join(" · ");
  return {
    text: `New issue created: ${title}`,
    blocks: [
      section(`:new: *Issue created*\n<${baseUrl}/issues/${issueId}|${title}>`),
      context(meta),
    ],
  };
}

export function formatIssueDone(payload: Payload, issueId: string, baseUrl: string): SlackContent {
  const title = escapeMrkdwn(str(payload, "title") || issueId);
  return {
    text: `Issue completed: ${title}`,
    blocks: [section(`:white_check_mark: *Issue completed*\n<${baseUrl}/issues/${issueId}|${title}>`)],
  };
}

export function formatAgentRunFailed(payload: Payload): SlackContent {
  const error = escapeMrkdwn(str(payload, "error") || str(payload, "message") || "Unknown error");
  const agentName = escapeMrkdwn(str(payload, "agentName") || str(payload, "agentId"));
  return {
    text: `Agent run failed${agentName ? ` (${agentName})` : ""}`,
    blocks: [
      section(`:x: *Agent run failed*${agentName ? ` — ${agentName}` : ""}`),
      section(`\`\`\`${error.slice(0, 2800)}\`\`\``),
    ],
  };
}

export function formatApprovalCreated(approvalId: string, payload: Payload, baseUrl: string): SlackContent {
  const title = escapeMrkdwn(str(payload, "title") || str(payload, "description") || approvalId);
  return {
    text: `Approval requested: ${title}`,
    blocks: [
      section(`:raised_hand: *Approval requested*\n${title}`),
      {
        type: "actions",
        elements: [
          {
            type: "button",
            action_id: ACTION_IDS.approvalApprove,
            style: "primary",
            text: { type: "plain_text", text: "Approve" },
            value: approvalId,
          },
          {
            type: "button",
            action_id: ACTION_IDS.approvalReject,
            style: "danger",
            text: { type: "plain_text", text: "Reject" },
            value: approvalId,
          },
          {
            type: "button",
            text: { type: "plain_text", text: "View" },
            url: `${baseUrl}/approvals/${approvalId}`,
          },
        ],
      },
    ],
  };
}

export function formatApprovalDecided(
  approvalId: string,
  decision: "approve" | "reject",
  deciderName: string,
): SlackContent {
  const name = escapeMrkdwn(deciderName);
  const label = decision === "approve" ? ":white_check_mark: Approved" : ":no_entry: Rejected";
  const text = `${label} by ${name} (approval ${approvalId})`;
  return { text, blocks: [section(text)] };
}

// Decision statuses we recognize well enough to render as a verdict. The
// approval.decided payload shape and the full status vocabulary are
// host-defined and the published SDK may lag the host (revision_requested,
// for one, may or may not be terminal), so anything outside these sets is
// quoted verbatim rather than guessed at.
const APPROVED_STATUSES = new Set(["approved", "approve"]);
const REJECTED_STATUSES = new Set(["rejected", "reject"]);

/**
 * The decided state of an approval that was decided somewhere other than
 * this Slack message — the Paperclip web UI, the API, another integration.
 *
 * Carries no action buttons, which is the entire point: rendering this over
 * the original message is what retires the live Approve/Reject buttons.
 * Decider attribution appears only when the payload actually carries one.
 */
export function formatApprovalDecidedElsewhere(approvalId: string, payload: Payload): SlackContent {
  const raw = str(payload, "status") || str(payload, "decision");
  const decider = str(payload, "decidedByName") || str(payload, "decidedBy");
  const label = APPROVED_STATUSES.has(raw)
    ? ":white_check_mark: Approved"
    : REJECTED_STATUSES.has(raw)
      ? ":no_entry: Rejected"
      : raw
        ? `:information_source: Decided — ${escapeMrkdwn(raw)}`
        : ":information_source: Decided";
  const by = decider ? ` by ${escapeMrkdwn(decider)}` : "";
  const text = `${label}${by} (approval ${approvalId})`;
  return {
    text,
    blocks: [section(text), context("Decided outside Slack; the buttons no longer apply.")],
  };
}

export function formatQuestion(question: string, mode: QuestionMode): SlackContent {
  const q = escapeMrkdwn(question);
  const hint =
    mode === "reaction"
      ? "React to this message with an emoji to answer. Your reaction will be recorded on the issue."
      : "Reply in this thread to answer. Your reply will be recorded on the issue.";
  return {
    text: `Question from a Paperclip agent: ${q}`,
    blocks: [section(`:question: *A Paperclip agent asks:*\n${q}`), context(hint)],
  };
}

export function formatQuestionResolved(question: string, response: string, responderName: string): SlackContent {
  const q = escapeMrkdwn(question);
  const resp = escapeMrkdwn(response);
  const name = escapeMrkdwn(responderName);
  const text = `Answered by ${name}: ${resp}`;
  return {
    text,
    blocks: [
      section(`:question: ~${q}~`),
      section(`:speech_balloon: *${name}* answered: ${resp}`),
      context("Recorded on the issue."),
    ],
  };
}

export function formatQuestionExpired(question: string): SlackContent {
  const q = escapeMrkdwn(question);
  const text = `Question expired without a response: ${q}`;
  return {
    text,
    blocks: [section(`:hourglass: ~${q}~`), context("Expired without a response.")],
  };
}
