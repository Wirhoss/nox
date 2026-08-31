import { contentToString, MEMORY_FACT_KINDS, z } from '@nox/extension-api';

import type { DraftFact, StoredFact } from './store';
import type { ChatModel, Message, UserMessage } from '@nox/extension-api';

/**
 * The kinds worth telling apart, taken from the contract rather than declared here.
 *
 * The same list the agent's own memory tools offer. When these were two lists
 * they drifted, and a fact written by hand under a kind the extractor never
 * produces is one consolidation will not compare against anything.
 */
const FACT_KINDS = MEMORY_FACT_KINDS;

/** Enough of a turn to extract from; a whole tool loop is not what was said. */
const MAX_TRANSCRIPT_CHARS = 12_000;

/** How many currently-believed facts the extractor is shown to contradict. */
const MAX_EXISTING_FACTS = 100;

const EXTRACTION_PROMPT = `You maintain an agent's long-term memory. You are shown one
conversation turn and the facts currently believed about this person. You decide what,
if anything, the turn changed.

Return JSON and nothing else, in this shape:

{"facts": [{"kind": "...", "text": "...", "confidence": 0.0, "invalidates": [12]}]}

- "kind" is one of: ${FACT_KINDS.join(', ')}.
  identity: who they are and what does not change. preference: what they like or want
  done. decision: something settled that later work depends on. state: something true
  of them for now, which will change again. Emit each claim once, under the single
  best kind; never store parallel preference and state versions of the same claim.
- "text" is one self-contained statement in the third person, in the language the turn
  was held in. It must make sense read alone months later, so resolve every pronoun and
  relative date: "she" and "next Tuesday" are useless without the turn around them.
  Write every resolved calendar date as ISO-8601 YYYY-MM-DD.
- "confidence" is 0.0 to 1.0. Something stated plainly is high; something inferred from
  tone or a single passing mention is low.
- "invalidates" lists the ids of shown facts this one ends. Use it when the new
  statement makes an old one no longer true — a move, a change of mind, a finished
  project. Do not use it for a fact that is merely related, a narrower choice for one
  task, or one the turn explicitly says remains true alongside the new one.
- "reinforces" is the id of a shown fact that says the same claim. Use it instead of
  creating another fact when this turn independently repeats what is already believed.
  Do not omit that repeated claim: a turn may return one reinforced fact and a different
  new fact together. Omit it only for a new claim. A reinforcement never invalidates anything.

Extract only what the person revealed about themselves or their work, and only what is
worth having again. Not what the assistant said, not what the turn was about, not
passing chatter. A turn that revealed nothing returns {"facts": []} — that is the
common case and it is the right answer.`;

const EXTRACTION_REQUEST = 'Extract from this turn now.';

const draftSchema = z.object({
  confidence: z.number().min(0).max(1).default(0.5),
  invalidates: z.array(z.number().int().positive()).default([]),
  kind: z.enum(FACT_KINDS),
  reinforces: z.number().int().positive().optional(),
  text: z.string().trim().min(1).max(500),
});
const extractionSchema = z.object({ facts: z.array(draftSchema).max(20).default([]) });

interface ExtractionRequest {
  readonly existing: readonly StoredFact[];
  readonly model: ChatModel;
  readonly occurredAt: Date;
  readonly signal?: AbortSignal;
  readonly transcript: string;
}

/**
 * Nox asking itself what to remember.
 *
 * The principal is this memory rather than the person whose turn it is: the
 * request is the extension's, it never enters a transcript, and attributing it
 * to the person would put words in their mouth in the one record that outlives
 * the conversation.
 */
function extractionMessage(text: string): UserMessage {
  const messageId = `memory-extraction-${Date.now().toString(36)}`;
  return Object.freeze({
    content: Object.freeze([{ text: `${text}\n\n${EXTRACTION_REQUEST}`, type: 'text' } as const]),
    createdAt: new Date(),
    messageId,
    origin: Object.freeze({
      principal: Object.freeze({ issuer: 'nox.memory.semantic', subject: 'extraction' }),
      transportMessageId: messageId,
    }),
    role: 'user',
  }) satisfies UserMessage;
}

/**
 * Whatever JSON the model surrounded with prose.
 *
 * Asked for JSON and nothing else, models still return a fenced block or a
 * sentence of introduction often enough that a stricter prompt would not remove
 * the need for this — and a turn whose extraction was thrown away for a stray
 * backtick is a memory silently missing a day.
 */
function jsonFrom(answer: string): unknown {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/u.exec(answer);
  const candidate = fenced?.[1] ?? answer;
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start === -1 || end <= start) return undefined;
  try {
    return JSON.parse(candidate.slice(start, end + 1)) as unknown;
  } catch {
    return undefined;
  }
}

function truncate(text: string, limit: number): string {
  const trimmed = text.trim();
  return trimmed.length <= limit ? trimmed : `${trimmed.slice(0, limit).trimEnd()}…`;
}

/** The currently-believed facts, as the ids the extractor may invalidate. */
function renderExisting(facts: readonly StoredFact[]): string {
  if (facts.length === 0) return 'Nothing is believed about this person yet.';
  return [
    'Currently believed:',
    ...facts
      .slice(0, MAX_EXISTING_FACTS)
      .map((fact) => `${String(fact.factId)}. [${fact.kind}] ${fact.text}`),
  ].join('\n');
}

/**
 * Turns one retained turn into the statements worth keeping.
 *
 * Returns nothing rather than throwing when the model answers something
 * unusable: extraction runs outside the conversation, so its failure must cost
 * the turn's facts and never the turn itself, which is already stored.
 */
async function extract(request: ExtractionRequest): Promise<readonly DraftFact[]> {
  const prompt = [
    // Given because the prompt asks for relative dates to be resolved, and
    // "next Tuesday" cannot be resolved by a model told neither when the turn
    // happened nor when it is being read.
    `This turn happened on ${request.occurredAt.toISOString()}.`,
    '',
    renderExisting(request.existing),
    '',
    'The turn:',
    truncate(request.transcript, MAX_TRANSCRIPT_CHARS),
  ].join('\n');

  const stream = request.model.stream(EXTRACTION_PROMPT, [extractionMessage(prompt)], [], {
    ...(request.signal === undefined ? {} : { signal: request.signal }),
  });
  const answer = (await stream.completed)
    .filter((message: Message) => message.role === 'assistant')
    .map((message) => contentToString(message.content))
    .join('\n');

  const parsed = extractionSchema.safeParse(jsonFrom(answer));
  if (!parsed.success) return [];

  const believed = new Set(request.existing.map((fact) => fact.factId));
  const validFrom = request.occurredAt.toISOString();
  return parsed.data.facts.flatMap((fact): DraftFact[] => {
    // A hallucinated reinforcement is not a new claim. Treating it as one would
    // turn a failed deduplication instruction into the duplicate it was meant
    // to prevent.
    if (fact.reinforces !== undefined && !believed.has(fact.reinforces)) return [];
    return [
      {
        confidence: fact.confidence,
        // Only ids the model was actually shown. A hallucinated id must retire
        // nothing, and the store refuses out-of-scope ones a second time.
        invalidates: Object.freeze(
          fact.reinforces === undefined ? fact.invalidates.filter((id) => believed.has(id)) : [],
        ),
        kind: fact.kind,
        ...(fact.reinforces === undefined ? {} : { reinforces: fact.reinforces }),
        text: fact.text,
        validFrom,
      },
    ];
  });
}

export { extract, EXTRACTION_PROMPT, FACT_KINDS, jsonFrom };

export type { ExtractionRequest };
