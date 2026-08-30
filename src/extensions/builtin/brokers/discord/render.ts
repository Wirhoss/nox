/** Discord refuses a message body longer than this. */
const MESSAGE_LIMIT = 2000;

/** Left free so a reopened code fence always fits in the chunk that needs it. */
const FENCE_HEADROOM = 12;

const FENCE = /^\s*(`{3,}|~{3,})(.*)$/;

interface OpenFence {
  readonly info: string;
  readonly marker: string;
}

/**
 * Whether this line opens or closes a fenced block, and with what. A closing
 * fence carries no info string, which is how the two are told apart when the
 * markers match.
 */
function fenceOf(line: string): OpenFence | undefined {
  const match = FENCE.exec(line);
  if (match === null) return undefined;

  return { info: (match[2] ?? '').trim(), marker: match[1] ?? '```' };
}

/**
 * Splits one line that is longer than a whole message on its own. Nothing here
 * can be preserved — a single unbroken run of characters has no boundary to cut
 * on — so it is cut on the limit, which at least keeps the text complete.
 */
function hardSplit(line: string, limit: number): string[] {
  const pieces: string[] = [];
  for (let from = 0; from < line.length; from += limit) {
    pieces.push(line.slice(from, from + limit));
  }
  return pieces;
}

/**
 * One reply as a sequence of messages Discord will accept. Splitting is on line
 * boundaries — a chat message is read rather than parsed, and a sentence cut
 * mid-word reads as a bug. The one structure actively repaired is the code
 * fence: a block split across two messages would render as prose in the first
 * and as an unterminated block in the second, so the fence is closed at the end
 * of one chunk and reopened, with its language, at the start of the next.
 *
 * Text already short enough comes back as itself — the case that matters, since
 * most replies are one message and pay nothing for this.
 */
function chunkMessage(text: string, limit: number = MESSAGE_LIMIT): readonly string[] {
  const trimmed = text.trim();
  if (trimmed.length === 0) return [];
  if (trimmed.length <= limit) return [trimmed];

  const budget = limit - FENCE_HEADROOM;
  const chunks: string[] = [];
  let current: string[] = [];
  let size = 0;
  let fence: OpenFence | undefined;

  const flush = (): void => {
    if (current.length === 0) return;

    const body = fence === undefined ? current : [...current, fence.marker];
    chunks.push(body.join('\n').trim());
    current = fence === undefined ? [] : [`${fence.marker}${fence.info}`];
    size = current.reduce((total, line) => total + line.length + 1, 0);
  };

  for (const rawLine of trimmed.split('\n')) {
    const lines = rawLine.length > budget ? hardSplit(rawLine, budget) : [rawLine];

    for (const line of lines) {
      if (size + line.length + 1 > budget) flush();

      current.push(line);
      size += line.length + 1;

      const marker = fenceOf(line);
      if (marker === undefined) continue;
      // A fence with no info string closes the block it matches; anything else
      // opens one. Nested fences are not a thing Markdown has, so an open fence
      // is either closed by this line or still open after it.
      if (fence === undefined) {
        fence = marker;
      } else if (marker.info.length === 0) {
        fence = undefined;
      }
    }
  }

  flush();
  return chunks.filter((chunk) => chunk.length > 0);
}

export { chunkMessage, FENCE_HEADROOM, MESSAGE_LIMIT };
