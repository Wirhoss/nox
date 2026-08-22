import { nanoid } from 'nanoid';

import { SYSTEM_INTERNAL } from '../auth/principal';
import { freezeMessage } from './context/immutable';
import { contentToString, type Message, type UserMessage } from './context/message';

import type { Logger } from '../logger/logger';
import type { ModelConfig } from '../provider/config';
import type { ChatProvider } from '../provider/provider';

const TITLE_REQUEST_PREFIX = 'title-request';

/** How much of each side of the exchange the model is shown. A title is not a summary. */
const MAX_EXCERPT_CHARS = 1_200;

/** Long enough to say what the conversation is, short enough for a list item. */
const MAX_TITLE_CHARS = 60;

const TITLE_PROMPT = `You are naming an agent session so a person can find it again in a
list of conversations.

You are shown the opening of the session: what was asked, and what came
back. Name what the session is about, in the language it was held in.

Rules:
- Output the title and nothing else. No quotes, no punctuation at the end,
  no preamble.
- At most ${String(MAX_TITLE_CHARS)} characters, ideally under 40.
- Say the subject, not the act: "Redis timeouts in the cache layer", never
  "Request for help with Redis" or "The user asks about Redis".
- Keep identifiers exactly as written: file paths, symbol names, error
  codes, config keys, IDs.
- Never invent a subject the excerpt does not have. When the opening says
  nothing nameable — a greeting, a test, an aborted thought — output
  exactly: UNTITLED`;

/** What the model is told to do with the excerpt it was just shown. */
const TITLE_REQUEST = 'Name this session now.';

/** The answer that means the opening was not worth a name. */
const NO_TITLE = 'UNTITLED';

interface TitleRequest {
  /** The transcript to name from; only its opening is read. */
  readonly history: readonly Message[];
  readonly logger?: Logger;
  /** Defaults to the provider's own default when the caller names none. */
  readonly model?: ModelConfig;
  readonly provider: ChatProvider;
  readonly signal?: AbortSignal;
}

function truncate(text: string, limit: number): string {
  const collapsed = text.trim();
  if (collapsed.length <= limit) return collapsed;
  return `${collapsed.slice(0, limit).trimEnd()}…`;
}

/**
 * The opening of the session, as prose.
 *
 * Rendered rather than replayed as messages: the first exchange may already
 * contain a tool loop, and a call handed to a provider without its result — or
 * the other way round — is a malformed request in most wire formats. A title is
 * read off what was said either way, so the tool traffic is left out entirely.
 */
function excerpt(history: readonly Message[]): string | undefined {
  const parts: string[] = [];

  for (const message of history) {
    if (message.role === 'user') {
      parts.push(`User: ${truncate(contentToString(message.content), MAX_EXCERPT_CHARS)}`);
      continue;
    }
    if (message.role !== 'assistant') continue;

    const text = contentToString(message.content).trim();
    if (text.length === 0) continue;
    parts.push(`Agent: ${truncate(text, MAX_EXCERPT_CHARS)}`);
    break;
  }

  // A title needs something that was asked. An opening that is only the agent
  // talking — a deferred result waking it — is not the session's subject.
  return parts.some((part) => part.startsWith('User:')) ? parts.join('\n\n') : undefined;
}

/**
 * Nox asking itself for a name. Like the compaction handoff it never enters the
 * transcript and never starts a run, but it is still a message from somebody:
 * the internal system principal, which holds nothing and is granted nothing.
 */
function createTitleRequest(text: string): UserMessage {
  const messageId = `${TITLE_REQUEST_PREFIX}-${nanoid()}`;
  return freezeMessage<UserMessage>({
    content: [{ text: `${text}\n\n${TITLE_REQUEST}`, type: 'text' }],
    createdAt: new Date(),
    messageId,
    origin: { principal: SYSTEM_INTERNAL, transportMessageId: messageId },
    role: 'user',
  });
}

/**
 * One line out of whatever the model sent. Models answer this prompt with a
 * quoted phrase, a trailing full stop or a "Title:" prefix often enough that
 * stripping them here is cheaper than a stricter prompt that still would not
 * guarantee it.
 */
function sanitize(raw: string): string | undefined {
  const line = raw
    .split('\n')
    .map((candidate) => candidate.trim())
    .find((candidate) => candidate.length > 0);
  if (line === undefined) return undefined;

  // Trailing punctuation is stripped on both sides of the quotes: a model that
  // answers `Title: "Redis timeouts".` leaves one of each in the way.
  const cleaned = line
    .replace(/^(?:title|título|titulo)\s*:\s*/iu, '')
    .replace(/\s+/gu, ' ')
    .replace(/[.,;:]+$/u, '')
    .replace(/^["'“”«»]+|["'“”«»]+$/gu, '')
    .replace(/[.,;:]+$/u, '')
    .trim();

  if (cleaned.length === 0 || cleaned.toUpperCase() === NO_TITLE) return undefined;
  if (cleaned.length <= MAX_TITLE_CHARS) return cleaned;

  // Cut on a word boundary when there is one to cut on; a title sliced
  // mid-identifier reads as a different identifier.
  const cut = cleaned.slice(0, MAX_TITLE_CHARS);
  const boundary = cut.lastIndexOf(' ');
  return `${(boundary > MAX_TITLE_CHARS / 2 ? cut.slice(0, boundary) : cut).trimEnd()}…`;
}

/**
 * Names a session from its opening, or answers nothing when the model declined
 * to — a greeting is a conversation that has not become about anything yet, and
 * a made-up name for it is worse than the id it already has.
 */
async function generateTitle(request: TitleRequest): Promise<string | undefined> {
  const opening = excerpt(request.history);
  if (opening === undefined) return undefined;

  const stream = request.provider.getMessageStream(
    TITLE_PROMPT,
    [createTitleRequest(opening)],
    [],
    { model: request.model, signal: request.signal },
  );

  const answer = (await stream.completed)
    .filter((message) => message.role === 'assistant')
    .map((message) => contentToString(message.content))
    .join('\n');

  const title = sanitize(answer);
  if (title === undefined) {
    request.logger?.debug({ answer }, 'The title provider returned no usable title.');
  }
  return title;
}

export { generateTitle, MAX_TITLE_CHARS, TITLE_PROMPT };

export type { TitleRequest };
