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

export function formatIssueCreated(payload: Payload, issueId: string, baseUrl: string): SlackContent {
  const title = str(payload, "title") || issueId;
  const meta = [
    `Status: ${str(payload, "status") || "todo"}`,
    str(payload, "priority") ? `Priority: ${str(payload, "priority")}` : "",
  ].filter(Boolean).join(" · ");
  return {
    text: `New issue created: ${title}`,
    blocks: [
      section(`:new: *Issue created*\n<${baseUrl}/issues/${issueId}|${title}>`),
      context(meta),
    ],
  };
}

export function formatIssueDone(payload: Payload, issueId: string, baseUrl: string): SlackContent {
  const title = str(payload, "title") || issueId;
  return {
    text: `Issue completed: ${title}`,
    blocks: [section(`:white_check_mark: *Issue completed*\n<${baseUrl}/issues/${issueId}|${title}>`)],
  };
}

export function formatAgentRunFailed(payload: Payload): SlackContent {
  const error = str(payload, "error") || str(payload, "message") || "Unknown error";
  const agentName = str(payload, "agentName") || str(payload, "agentId");
  return {
    text: `Agent run failed${agentName ? ` (${agentName})` : ""}`,
    blocks: [
      section(`:x: *Agent run failed*${agentName ? ` — ${agentName}` : ""}`),
      section(`\`\`\`${error.slice(0, 2800)}\`\`\``),
    ],
  };
}

export function formatApprovalCreated(approvalId: string, payload: Payload, baseUrl: string): SlackContent {
  const title = str(payload, "title") || str(payload, "description") || approvalId;
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
  const label = decision === "approve" ? ":white_check_mark: Approved" : ":no_entry: Rejected";
  const text = `${label} by ${deciderName} (approval ${approvalId})`;
  return { text, blocks: [section(text)] };
}

export function formatQuestion(question: string, mode: QuestionMode): SlackContent {
  const hint =
    mode === "reaction"
      ? "React to this message with an emoji to answer. Your reaction will be recorded on the issue."
      : "Reply in this thread to answer. Your reply will be recorded on the issue.";
  return {
    text: `Question from a Paperclip agent: ${question}`,
    blocks: [section(`:question: *A Paperclip agent asks:*\n${question}`), context(hint)],
  };
}

export function formatQuestionResolved(question: string, response: string, responderName: string): SlackContent {
  const text = `Answered by ${responderName}: ${response}`;
  return {
    text,
    blocks: [
      section(`:question: ~${question}~`),
      section(`:speech_balloon: *${responderName}* answered: ${response}`),
      context("Recorded on the issue."),
    ],
  };
}

export function formatQuestionExpired(question: string): SlackContent {
  const text = `Question expired without a response: ${question}`;
  return {
    text,
    blocks: [section(`:hourglass: ~${question}~`), context("Expired without a response.")],
  };
}
