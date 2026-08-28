import { freezeMessage } from './immutable';
import { messageToString } from './message';

import type { Logger } from '../../logger/logger';
import type { Message, MessageContentText, ToolResponseMessage } from '@nox/extension-api';

interface TranscriptOptions {
  logger?: Logger;
  onAppend?: (message: Message) => void;
}

/**
 * The permanent record of one session, in append order.
 *
 * It holds the messages and nothing derived from them. Searching used to live
 * here, over an index this class rebuilt in memory on every construction; it
 * now lives in storage, where it survives the process and can be asked about
 * more than one session. What stays is the part that is genuinely about *this*
 * conversation: the messages themselves, and the tool results the model may ask
 * to re-read in full.
 */
class Transcript {
  readonly #logger?: Logger;
  readonly #onAppend?: (message: Message) => void;

  readonly #knownIds = new Set<string>();
  readonly #messages: Message[] = [];
  readonly #toolResponses = new Map<string, ToolResponseMessage>();

  #snapshot?: readonly Message[];

  constructor(messages: readonly Message[] = [], options: TranscriptOptions = {}) {
    this.#logger = options.logger;
    this.#onAppend = options.onAppend;

    for (const message of messages) {
      if (this.#knownIds.has(message.messageId)) {
        options.logger?.warn(
          { messageId: message.messageId },
          'Skipping duplicate persisted message while rebuilding the transcript.',
        );
        continue;
      }
      this.#record(freezeMessage(message));
    }
  }

  public get messages(): readonly Message[] {
    this.#snapshot ??= Object.freeze([...this.#messages]);
    return this.#snapshot;
  }

  public append(message: Message): Message {
    const frozen = freezeMessage(message);
    if (this.#knownIds.has(frozen.messageId)) {
      throw new Error(`Duplicate message ID: ${frozen.messageId}.`);
    }

    this.#record(frozen);
    this.#snapshot = undefined;
    this.#notify(frozen);
    return frozen;
  }

  public readToolResult(
    trackId: string,
    offset: number,
    maxCharacters: number,
  ): MessageContentText[] {
    const message = this.#toolResponses.get(trackId);
    if (message === undefined) {
      throw new Error(`No tool response found for track ID: ${trackId}`);
    }

    const formatted = messageToString(message);
    if (offset >= formatted.length && formatted.length > 0) {
      throw new RangeError(
        `Offset ${String(offset)} is beyond tool result length ${String(formatted.length)}.`,
      );
    }

    const end = Math.min(offset + maxCharacters, formatted.length);
    const continuation =
      end < formatted.length
        ? `\n\n[Result truncated. Continue with offset ${String(end)}. ` +
          `Total characters: ${String(formatted.length)}.]`
        : '';
    return [
      {
        text: formatted.slice(offset, end) + continuation,
        type: 'text',
      },
    ];
  }

  /**
   * A failing sink must not turn an append into a lost message. The transcript
   * is the source of truth and appending to it is the one operation that is not
   * allowed to fail, so the failure is logged and swallowed — by then the
   * message is already recorded.
   */
  #notify(message: Message): void {
    if (this.#onAppend === undefined) return;

    try {
      this.#onAppend(message);
    } catch (error) {
      this.#logger?.error(
        { err: error, messageId: message.messageId },
        'Transcript append sink failed; the message was recorded but not handed off.',
      );
    }
  }

  #record(message: Message): void {
    this.#knownIds.add(message.messageId);
    this.#messages.push(message);

    if (
      message.role === 'toolResponse' &&
      message.execution !== 'deferredAck' &&
      message.execution !== 'permissionPending' &&
      !this.#toolResponses.has(message.trackId)
    ) {
      this.#toolResponses.set(message.trackId, message);
    }
  }
}

export { Transcript };

export type { TranscriptOptions };
