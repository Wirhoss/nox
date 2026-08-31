import { contentToString, z } from '@nox/extension-api';

import { jsonFrom } from './extraction';

import type { FactPair } from './store';
import type { ChatModel, Message, UserMessage } from '@nox/extension-api';

/**
 * The judgement asked of the model, and nothing wider.
 *
 * Deliberately not "are these related" or "which is better". The store already
 * knows the two are about one subject — that is what put them in front of the
 * model — and the only thing it cannot decide for itself is whether the world
 * changed between them. Everything else the prompt could ask would be a reason
 * to throw away a fact that is still true.
 */
const CONTRADICTION_PROMPT = `You maintain an agent's long-term memory. You are shown two
statements believed about the same person, stated at different times. Both are currently
held to be true. You decide whether the later one ended the earlier one.

Return JSON and nothing else, in this shape:

{"ended": true, "reason": "..."}

- "ended" is true only when the later statement makes the earlier one no longer true of
  the present: a move, a change of job, a preference reversed, a project finished. It is
  the same judgement as replacing an address, not the same as adding a second one.
- "ended" is false for everything else, and false is the common answer. Two statements
  that are both still true, a narrower case of a general rule, two things that merely sit
  near each other in wording, a detail added to something already known, or two facts
  about different subjects that happen to share vocabulary — none of these ended anything.
- When the two statements could both be true of one person at once, "ended" is false.
  Someone can play two instruments, hold two opinions, and work on two projects.
- "reason" is one short sentence saying why, in the language the statements are written in.

An answer of true retires a statement Nox will then stop recalling, so answer true only
when the earlier statement would now be wrong to say.`;

const CONTRADICTION_REQUEST = 'Decide now.';

const verdictSchema = z.object({
  ended: z.boolean(),
  reason: z.string().trim().max(500).optional(),
});

interface ContradictionRequest {
  readonly model: ChatModel;
  readonly pair: FactPair;
  readonly signal?: AbortSignal;
}

interface ContradictionVerdict {
  readonly ended: boolean;
  readonly reason?: string;
}

/**
 * Nox asking itself whether one belief ended another.
 *
 * Attributed to the memory rather than to the person, for the same reason
 * extraction is: the request is the extension's, it never enters a transcript,
 * and putting it in the person's mouth would falsify the one record that
 * outlives the conversation.
 */
function contradictionMessage(text: string): UserMessage {
  const messageId = `memory-contradiction-${Date.now().toString(36)}`;
  return Object.freeze({
    content: Object.freeze([
      { text: `${text}\n\n${CONTRADICTION_REQUEST}`, type: 'text' } as const,
    ]),
    createdAt: new Date(),
    messageId,
    origin: Object.freeze({
      principal: Object.freeze({ issuer: 'nox.memory.semantic', subject: 'contradiction' }),
      transportMessageId: messageId,
    }),
    role: 'user',
  }) satisfies UserMessage;
}

/**
 * Asks whether the later statement ended the earlier one.
 *
 * Returns "not ended" rather than throwing when the model answers something
 * unusable, because the cost of the two failures is not symmetric: a missed
 * contradiction leaves a stale fact that a later pass can still catch, while a
 * wrongly parsed one retires something true and nothing downstream would know.
 */
async function judgeContradiction(request: ContradictionRequest): Promise<ContradictionVerdict> {
  const { earlier, later } = request.pair;
  const prompt = [
    `Earlier statement, first true on ${earlier.validFrom}:`,
    `[${earlier.kind}] ${earlier.text}`,
    '',
    `Later statement, first true on ${later.validFrom}:`,
    `[${later.kind}] ${later.text}`,
  ].join('\n');

  const stream = request.model.stream(CONTRADICTION_PROMPT, [contradictionMessage(prompt)], [], {
    ...(request.signal === undefined ? {} : { signal: request.signal }),
  });
  const answer = (await stream.completed)
    .filter((message: Message) => message.role === 'assistant')
    .map((message) => contentToString(message.content))
    .join('\n');

  const parsed = verdictSchema.safeParse(jsonFrom(answer));
  if (!parsed.success) return { ended: false };
  return parsed.data.reason === undefined
    ? { ended: parsed.data.ended }
    : { ended: parsed.data.ended, reason: parsed.data.reason };
}

export { CONTRADICTION_PROMPT, judgeContradiction };

export type { ContradictionRequest, ContradictionVerdict };
