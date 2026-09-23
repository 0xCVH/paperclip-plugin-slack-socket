// Converts common Markdown (as an LLM agent tends to produce) into Slack's
// mrkdwn dialect so replies render correctly instead of showing literal
// `**`/`#`/`[text](url)` syntax in Slack.

// NUL-delimited placeholders, deliberately: agent text that reaches this
// function can contain any printable sequence — including something shaped
// like a placeholder — but a NUL byte cannot plausibly survive the upstream
// pipelines, so a stash token can never collide with (or be forged by) real
// content. Written as \u0000 escapes rather than literal NUL bytes so the
// source file itself stays text-diffable in git.
const CODE_PLACEHOLDER_PREFIX = "\u0000MRKDWN_CODE_";
const CODE_PLACEHOLDER_SUFFIX = "\u0000";

// Slack's mrkdwn parser fails to recognise a closing bold `*` when the
// character immediately before it is not a word character — `)`, `]`, `.`,
// `:`, `—` all trigger it — and then silently drops the REST OF THE MESSAGE,
// not just the bold span. A zero-width space between the last character and
// the closing `*` makes the delimiter land after something the parser
// accepts, invisibly to the reader.
const ZWSP = "\u200B";

function closesBoldSafely(inner: string): boolean {
  const last = inner.at(-1);
  return last !== undefined && /[\p{L}\p{N}_]/u.test(last);
}

// GFM pipe tables render in Slack as literal pipe noise — mrkdwn has no
// table syntax. Each table (a pipe row, a separator row of dashes, then any
// run of pipe rows) is rewritten as a fenced monospace block with
// space-aligned columns. This runs AFTER code has been stashed, so a table
// inside an existing fence stays byte-identical, and it emits THROUGH the
// stash, so cell content is never touched by the emphasis passes — inside a
// monospace fence, raw `**markdown**` reads better than half-converted
// markup. Alignment pads by UTF-16 length; wide (CJK) glyphs mis-align by a
// column or two, the accepted trade for not shipping a display-width table.
const TABLE_SEPARATOR_ROW = /^\s*\|?\s*:?-{2,}:?\s*(?:\|\s*:?-{2,}:?\s*)*\|?\s*$/;

function parseTableCells(line: string): string[] {
  let inner = line.trim();
  if (inner.startsWith("|")) inner = inner.slice(1);
  if (inner.endsWith("|")) inner = inner.slice(0, -1);
  return inner.split("|").map((cell) => cell.trim());
}

function wrapPipeTables(text: string, stash: (code: string) => string): string {
  const lines = text.split("\n");
  const out: string[] = [];
  let i = 0;
  while (i < lines.length) {
    const header = lines[i]!;
    const separator = lines[i + 1];
    const isTableStart =
      header.includes("|") &&
      !TABLE_SEPARATOR_ROW.test(header) &&
      separator !== undefined &&
      separator.includes("-") &&
      TABLE_SEPARATOR_ROW.test(separator);
    if (!isTableStart) {
      out.push(header);
      i += 1;
      continue;
    }
    const headerCells = parseTableCells(header);
    const rows: string[][] = [];
    let j = i + 2;
    while (j < lines.length && lines[j]!.includes("|") && !TABLE_SEPARATOR_ROW.test(lines[j]!)) {
      rows.push(parseTableCells(lines[j]!));
      j += 1;
    }
    const cols = Math.max(headerCells.length, ...rows.map((r) => r.length), 1);
    const widths = Array.from({ length: cols }, (_, c) =>
      Math.max(...[headerCells, ...rows].map((r) => (r[c] ?? "").length)),
    );
    const renderRow = (cells: string[]): string =>
      Array.from({ length: cols }, (_, c) => (cells[c] ?? "").padEnd(widths[c]!))
        .join(" | ")
        .trimEnd();
    const rendered = [
      renderRow(headerCells),
      widths.map((w) => "-".repeat(w)).join("-|-"),
      ...rows.map(renderRow),
    ];
    out.push(stash(`\`\`\`\n${rendered.join("\n")}\n\`\`\``));
    i = j;
  }
  return out.join("\n");
}

/**
 * Converts Markdown text to Slack mrkdwn.
 *
 * The function is a sequence of passes over the text, and every pass that
 * PRODUCES mrkdwn syntax stashes its output behind a placeholder so no later
 * pass can re-interpret it — converted bold `*x*` must not be re-matched by
 * the single-star italic pass, a converted link's URL must not have its `__`
 * segments bolded, and code spans must survive byte-for-byte. Placeholders
 * are restored innermost-last (reverse stash order), so a stashed value that
 * itself contains an earlier placeholder — bold wrapping an inline code
 * span, a header wrapping a link — resolves fully.
 */
export function markdownToMrkdwn(text: string): string {
  const stashed: string[] = [];
  const stash = (code: string): string => {
    const index = stashed.push(code) - 1;
    return `${CODE_PLACEHOLDER_PREFIX}${index}${CODE_PLACEHOLDER_SUFFIX}`;
  };

  // Fenced code blocks first (so an inline-code regex can't misparse a
  // fence's own backticks), then inline code spans.
  //
  // A genuine opening fence — one at the start of the text or of a line —
  // gets its language tag stripped: Slack does not treat ```python like
  // GitHub does, it renders a code block whose literal first line is
  // "python". The stash regex deliberately also matches from a mid-line
  // ``` (an inline ```span```); there the first "line" is real content and
  // must survive byte-for-byte, so the strip is gated on line position.
  let working = text.replace(/```[\s\S]*?```/g, (match, offset: number) => {
    const genuineFence = offset === 0 || text[offset - 1] === "\n";
    const block = genuineFence ? match.replace(/^```[^\s`]+[ \t]*(\r?\n)/, "```$1") : match;
    return stash(block);
  });
  working = working.replace(/`[^`\n]+`/g, (match) => stash(match));

  // Tables next (see wrapPipeTables): after code stashing so a table inside
  // a fence stays literal, before everything else so cell content is behind
  // a placeholder by the time the emphasis passes run.
  working = wrapPipeTables(working, stash);

  // Images before links: both use `[...](...)`, but images have a leading
  // `!` that must not be swallowed by the link pattern first.
  //
  // Only convert when the destination has a safe scheme (http/https/mailto,
  // matched case-insensitively). Callers escape `&`, `<`, `>` in the
  // agent's text before calling this function specifically to stop
  // Markdown from turning into a Slack mass-ping; emitting a bare
  // `<destination|label>` here for an arbitrary destination (e.g.
  // `[x](!channel)`) would reintroduce `<...>` and undo that protection.
  // A destination without a safe scheme is left exactly as written, so it
  // renders as harmless escaped plain text.
  //
  // The URL body tolerates one level of balanced parentheses so Wikipedia-
  // style `/wiki/Foo_(bar)` links survive, while the final `\)` still
  // anchors on the link's own closer. Converted output is stashed so the
  // emphasis passes below can never rewrite `_`/`*` inside a URL or label.
  const LINK_URL = "(?:https?:\\/\\/|mailto:)[^()\\s]*(?:\\([^()\\s]*\\)[^()\\s]*)*";
  working = working.replace(
    new RegExp(`!\\[([^\\]]*)\\]\\((${LINK_URL})\\)`, "gi"),
    (_m, alt: string, url: string) => stash(`<${url}|${alt}>`),
  );
  working = working.replace(
    new RegExp(`\\[([^\\]]*)\\]\\((${LINK_URL})\\)`, "gi"),
    (_m, label: string, url: string) => stash(`<${url}|${label}>`),
  );

  // Pre-existing Slack entities/manual links (`<@U…>`, `<https://…|x>`)
  // are stashed too, so the emphasis passes can't corrupt their innards.
  // On the chat path these only occur when upstream escaping was
  // deliberately skipped; formatter-authored markup passes through here
  // untouched either way.
  working = working.replace(/<(?:[@#!]|(?:https?|mailto|tel):)[^>\n]+>/g, (match) => stash(match));

  // Headers before the emphasis passes: leading #{1,6} per line -> bold
  // line, with any redundant `**`/`__` markers inside the header text
  // stripped rather than nested — `*Title *x**` renders broken in Slack.
  working = working.replace(/^#{1,6}\s+(.*)$/gm, (_m, inner: string) => {
    const flattened = inner.replace(/\*\*(.+?)\*\*/g, "$1").replace(/__(.+?)__/g, "$1").trim();
    return stash(`*${flattened}*`);
  });

  // Bold-italic before bold: ***x*** -> *_x_* (Slack bold wrapping italic).
  working = working.replace(/\*\*\*(.+?)\*\*\*/g, (_m, inner: string) => stash(`*_${inner}_*`));

  // Bold: **x** or __x__ -> *x*, with the ZWSP parser workaround (see above).
  const convertBold = (_m: string, inner: string): string =>
    stash(`*${inner}${closesBoldSafely(inner) ? "" : ZWSP}*`);
  working = working.replace(/\*\*(.+?)\*\*/g, convertBold);
  working = working.replace(/__(.+?)__/g, convertBold);

  // Italic: single *x* -> _x_ (Slack italic), only when the emphasised text
  // touches non-whitespace on both sides — `a * b * c` is arithmetic, not
  // emphasis. Double-star bold never reaches this pass: unconverted `**x**`
  // is excluded by the lookarounds, converted bold is already stashed.
  working = working.replace(/(?<!\*)\*(\S(?:[^*\n]*?\S)?)\*(?!\*)/g, (_m, inner: string) =>
    stash(`_${inner}_`),
  );

  // Strikethrough: ~~x~~ -> ~x~
  working = working.replace(/~~([^~]+)~~/g, "~$1~");

  // Leading list markers ("- " or "* ") -> bullet. Left anchored per line;
  // blockquotes ("> ") are untouched. Runs after the emphasis passes, whose
  // outputs are stashed behind placeholders that never start a line with
  // `-` or `*`.
  working = working.replace(/^[-*]\s+/gm, "• ");

  // Restore stashed values in REVERSE order, one placeholder at a time:
  // an outer stash (higher index) can contain an inner one's placeholder
  // (bold wrapping a code span), and restoring outermost-first exposes the
  // inner placeholder for a later iteration. The replacement is a callback,
  // never a string — a stashed value may contain `$`, which a string
  // replacement would interpret.
  for (let index = stashed.length - 1; index >= 0; index -= 1) {
    working = working.replaceAll(
      `${CODE_PLACEHOLDER_PREFIX}${index}${CODE_PLACEHOLDER_SUFFIX}`,
      () => stashed[index]!,
    );
  }

  return working;
}
