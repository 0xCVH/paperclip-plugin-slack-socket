// Text helpers shared by every path that posts agent-authored text to Slack
// (chat replies and the slack_post_message tool).

// Slack's chat.postMessage/chat.update reject payloads with roughly
// >4000-character text. Stay comfortably under that for both the rolling
// streamed update and each chunk of an overlong message.
export const MAX_MESSAGE_LENGTH = 3900;

/** Splits `text` into `size`-character chunks. Returns [] for empty input. */
export function splitIntoChunks(text: string, size: number): string[] {
  const chunks: string[] = [];
  for (let i = 0; i < text.length; i += size) chunks.push(text.slice(i, i + size));
  return chunks;
}
