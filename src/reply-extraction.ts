// Pulls the agent's usable reply out of what a completed turn hands back:
// the host's final message, and the raw stdout chunk stream accumulated
// during the run. Everything here is pure text processing — no ctx, no
// gateway — split out of chat.ts so the turn lifecycle and the extraction
// rules can evolve (and be tested) independently.

import { REPLY_CLOSE_TAG, REPLY_OPEN_TAG } from "./constants.js";

// Raw adapter stdout (streamed only when streamPartialReplies is enabled)
// can carry agent-runtime housekeeping lines like:
//   [paperclip] ACPX session "acpx:v2:…" does not match the current
//   agent/cwd/mode/runtime identity; starting fresh in "…"
// These aren't part of the reply and shouldn't show up in a Slack thread.
// This does NOT and cannot filter model chain-of-thought/reasoning that may
// also be present in raw stdout — that's exactly why final-reply-only is the
// default and streaming is an explicit opt-in.
const RUNTIME_NOTICE_LINE = /^\s*\[paperclip\]\s/;

export function filterRuntimeNoticeLines(text: string): string {
  return text
    .split("\n")
    .filter((line) => !RUNTIME_NOTICE_LINE.test(line))
    .join("\n");
}

// Pulls the agent's actual reply out of the <slack_reply>/</slack_reply>
// tags requested by DEFAULT_CHAT_PROMPT_PREAMBLE. A prompt instruction not
// to narrate isn't enough on its own — some adapters narrate *about* the
// instruction ("The key instruction is: '...' So I should just respond
// naturally.") and then jam the real answer directly onto the end with no
// separator, which makes line/paragraph heuristics unsafe. An explicit
// delimiter sidesteps that entirely: we don't guess where narration ends,
// we look for the marker the agent was told to use.
//
// - If one or more complete tag pairs are present, the LAST one wins (a
//   model may echo the instruction, tags and all, before its real reply).
// - If there's an opening tag with no matching close, everything after the
//   LAST opening tag is used (the agent started the tag but got cut off,
//   or streaming truncated the close).
// - Otherwise (no tags at all), the input is returned unchanged — this is
//   the fallback for agents/adapters that don't follow the tag instruction,
//   and it preserves the plugin's pre-0.6.0 behavior exactly.
// - If the extracted content would be empty, that's not a usable reply, so
//   fall back to the input unchanged rather than posting nothing.
export function extractReply(text: string): string {
  const closeIdx = text.lastIndexOf(REPLY_CLOSE_TAG);
  if (closeIdx !== -1) {
    const openIdx = text.lastIndexOf(REPLY_OPEN_TAG, closeIdx);
    if (openIdx !== -1) {
      const content = text.slice(openIdx + REPLY_OPEN_TAG.length, closeIdx).trim();
      if (content) return content;
      return text.trim();
    }
  }

  const openIdx = text.lastIndexOf(REPLY_OPEN_TAG);
  if (openIdx !== -1) {
    const content = text.slice(openIdx + REPLY_OPEN_TAG.length).trim();
    if (content) return content;
    return text.trim();
  }

  return text.trim();
}

// Strict sibling of extractReply, used ONLY on the streamed stdout buffer
// (see the withheld-transcript recovery in streamReply's done branch): the
// content of the LAST COMPLETE tag pair, or null. Deliberately none of
// extractReply's fallbacks — no unclosed-open recovery (a chunk stream can be
// truncated mid-tag, and "everything after the open tag" of a truncated
// stream is arbitrary transcript, not a reply) and no return-input-unchanged
// (raw stdout can carry the model's reasoning and tool output; posting it
// whole is exactly what final-reply-only mode exists to prevent). Kept as a
// separate function rather than a mode of extractReply because the two
// diverge on every no-complete-pair shape, including the empty-pair case
// extractReply resolves to text.trim().
export function extractTaggedReply(text: string): string | null {
  const closeIdx = text.lastIndexOf(REPLY_CLOSE_TAG);
  if (closeIdx === -1) return null;
  const openIdx = text.lastIndexOf(REPLY_OPEN_TAG, closeIdx);
  if (openIdx === -1) return null;
  const content = text.slice(openIdx + REPLY_OPEN_TAG.length, closeIdx).trim();
  return content || null;
}

// Hermes prints the complete input prompt to stdout before this boundary.
// That prompt necessarily contains the literal example
//   <slack_reply> and </slack_reply>
// from our conversational framing. If inference then fails before producing
// an answer, scanning the whole raw transcript would recover the word "and"
// from the echoed instruction and post it as though it were the agent's
// reply. Only stdout after Hermes hands off to the model can contain a
// model-authored reply. Other adapters that do not emit this marker retain
// the existing raw-stream behaviour.
export const HERMES_AGENT_OUTPUT_BOUNDARY = "Initializing agent...";

export function extractRawStreamedTaggedReply(text: string): string | null {
  const boundaryIdx = text.lastIndexOf(HERMES_AGENT_OUTPUT_BOUNDARY);
  const agentOutput =
    boundaryIdx === -1
      ? text
      : text.slice(boundaryIdx + HERMES_AGENT_OUTPUT_BOUNDARY.length);
  return extractTaggedReply(filterRuntimeNoticeLines(agentOutput));
}

// The claude_local adapter's stdout is a stream of newline-delimited ACP
// envelopes, not raw text — the agent's message text arrives as
//   {"type":"acpx.text_delta","text":"…","channel":"output","tag":"agent_message_chunk"}
// lines, one fragment per delta. Searching the accumulated buffer for the
// reply tags directly is wrong against that shape twice over: a tag split
// across two deltas never matches as a literal, and a pair whose halves sit
// in DIFFERENT envelopes matches while everything between them is JSON
// scaffolding and \n escape sequences, not the reply. This reconstructs the
// agent's actual text by parsing each envelope line and concatenating the
// output-channel deltas' text fields (JSON.parse also restores the escaped
// newlines/quotes). Verified against two real failed runs: the
// concatenation matches the host's resultJson.summary length exactly.
//
// The channel filter is load-bearing for security, not just fidelity: only
// "output" (agent-message) deltas contribute, so the reconstructed text is
// agent-authored by construction — tool output transiting the stream on
// other channels can never plant a tag pair in it. That authorship property
// is what lets the recovery below trigger on ANY untagged host text rather
// than only the sentinel.
//
// Returns null when NO acpx.text_delta envelope was seen at all (the buffer
// is not an envelope stream — a different adapter streaming plain text),
// and the concatenated output text (possibly "") when envelopes were seen.
// The distinction matters: once the buffer is known to be envelope-shaped,
// the raw-buffer fallback below must NOT run — a literal tag pair inside an
// envelope's JSON (on any channel) is exactly the false match this function
// exists to prevent.
export function reconstructStreamedAgentText(buffer: string): string | null {
  let sawEnvelope = false;
  let out = "";
  for (const line of buffer.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) continue;
    let envelope: unknown;
    try {
      envelope = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (typeof envelope !== "object" || envelope === null) continue;
    const record = envelope as Record<string, unknown>;
    if (record.type !== "acpx.text_delta") continue;
    sawEnvelope = true;
    if (record.channel === "output" && typeof record.text === "string") {
      out += record.text;
    }
  }
  return sawEnvelope ? out : null;
}

// The Paperclip host does not hand a plugin session the agent's final text:
// it builds the done event's message with buildHeartbeatRunIssueComment
// (@paperclipai/server services/heartbeat-run-summary.js), the BOARD comment
// sanitizer, which replaces the run's whole concatenated assistant text with
// this fixed notice whenever it exceeds MAX_FALLBACK_COMMENT_CHARS (1200) or
// opens with a narration phrase ("I'll …", "Let me …" — NARRATION_OPENERS).
// An agent that follows this plugin's own preamble (thinking outside the
// tags, a substantive reply inside them) trips one of those on almost every
// real answer, so the reply this plugin was designed to extract arrives
// replaced by the notice below — while the genuine tagged reply streamed
// past in the stdout chunk events. This constant mirrors the host's
// FALLBACK_WITHHELD_COMMENT byte for byte; if the host ever rewords it, the
// recovery path silently degrades to posting the host's text verbatim —
// today's pre-recovery behavior, visible in the channel — rather than
// failing in some new way.
export const HOST_WITHHELD_REPLY_NOTICE =
  "Run completed. Agent did not post a summary comment this run (transcript withheld — see run log).";

// Posted when the host withheld the transcript AND no complete tagged reply
// could be recovered from the streamed buffer. Plugin-authored trusted text
// (like the turn-timeout notice) — it does not pass through the agent-text
// escaping pipeline. Phrased truthfully: the run finished; its reply text
// was withheld host-side, not lost by the agent.
export const WITHHELD_REPLY_USER_NOTICE =
  ":information_source: The run finished, but the host withheld the agent's reply text from this conversation (transcript withheld — see the run log in Paperclip). Mention me again to retry.";
