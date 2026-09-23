// Text helpers shared by every path that posts agent-authored text to Slack
// (chat replies and the slack_post_message tool).

// Slack's chat.postMessage/chat.update reject payloads with roughly
// >4000-character text. Stay comfortably under that for both the rolling
// streamed update and each chunk of an overlong message.
export const MAX_MESSAGE_LENGTH = 3900;

// Head-room kept free in every chunk for what splitting itself appends: a
// "\n```" fence close (4) plus a "\n_(12/34)_" part indicator (~11). The
// budget each chunk accumulates against is `size - RESERVE`, so the final
// decorated chunk always stays within `size`.
const SPLIT_RESERVE = 24;

/**
 * Splits `text` into chunks of at most `size` characters. Returns [] for
 * empty input, and the text unchanged (no part indicator) when it fits in
 * one chunk.
 *
 * A multi-chunk split is fence-aware and labelled:
 * - Splits land on line boundaries wherever possible; only a single line
 *   longer than the budget is hard-sliced.
 * - A chunk boundary inside an open ``` fence closes the fence at the end
 *   of the chunk and reopens it at the start of the next, so no chunk ever
 *   renders half its content as accidental code (or code as prose). An
 *   unbalanced input fence is closed at the end rather than left dangling.
 * - Every chunk carries a trailing `_(i/n)_` part indicator, so a reader
 *   (and anyone quoted a single chunk) can tell it is part of a longer
 *   reply.
 */
export function splitIntoChunks(text: string, size: number): string[] {
  if (text.length === 0) return [];
  if (text.length <= size) return [text];

  const budget = Math.max(1, size - SPLIT_RESERVE);
  const chunks: string[] = [];
  let current = "";
  let fenceOpen = false;

  const append = (piece: string): void => {
    current = current ? `${current}\n${piece}` : piece;
  };
  const flush = (): void => {
    chunks.push(fenceOpen ? `${current}\n\`\`\`` : current);
    // Reopen inside the next chunk so its fenced content stays fenced. The
    // language tag is not carried over: markdownToMrkdwn already strips
    // tags from genuine fences before any text reaches this splitter.
    current = fenceOpen ? "```" : "";
  };

  for (const line of text.split("\n")) {
    if (line.length > budget) {
      // A single line that cannot fit any chunk: hard-slice it. Slices
      // join with no separator, so the strip-and-rejoin of the pieces
      // reproduces the original line exactly.
      let rest = line;
      while (rest.length > 0) {
        const room = budget - current.length - (current ? 1 : 0);
        if (room <= 0) {
          flush();
          continue;
        }
        const piece = rest.slice(0, room);
        rest = rest.slice(room);
        current = current ? `${current}\n${piece}` : piece;
        if (rest.length > 0) flush();
      }
      if (/^```/.test(line)) fenceOpen = !fenceOpen;
      continue;
    }
    if (current.length + 1 + line.length > budget) flush();
    append(line);
    if (/^```/.test(line)) fenceOpen = !fenceOpen;
  }
  // Final chunk — skip a residue that is only the fence reopener a flush
  // left behind with nothing after it.
  if (current && !(current === "```" && fenceOpen)) {
    chunks.push(fenceOpen ? `${current}\n\`\`\`` : current);
  }

  if (chunks.length === 1) return [chunks[0]!];
  return chunks.map((chunk, i) => `${chunk}\n_(${i + 1}/${chunks.length})_`);
}
