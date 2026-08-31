import { Mutex } from '@nox/extension-api';

import type { Logger, SecretHandle } from '@nox/extension-api';

const API_BASE = 'https://discord.com/api/v10';

/** How many times one call is retried after a rate limit or a 5xx. */
const MAX_ATTEMPTS = 4;

/** Ceiling for a `Retry-After` Nox is willing to wait inline. */
const MAX_RETRY_WAIT_MS = 30_000;

/** Discord's flag for a reply only the person who clicked can see. */
const EPHEMERAL = 64;

/** The interaction callback kinds this transport uses. */
const INTERACTION_REPLY = 4;
const INTERACTION_UPDATE_MESSAGE = 7;

interface DiscordButton {
  readonly custom_id: string;
  readonly disabled?: boolean;
  readonly label: string;
  /** 1 primary, 2 secondary, 3 success, 4 danger. */
  readonly style: 1 | 2 | 3 | 4;
  readonly type: 2;
}

interface DiscordActionRow {
  readonly components: readonly DiscordButton[];
  readonly type: 1;
}

interface DiscordMessagePayload {
  readonly components?: readonly DiscordActionRow[];
  readonly content?: string;
  /** Replies to a specific message, which is how a thread of answers reads. */
  readonly message_reference?: { readonly fail_if_not_exists: false; readonly message_id: string };
}

/**
 * One file posted with a message.
 *
 * The bytes are held rather than streamed: a multipart body of unknown length
 * would go up chunked, which Discord's upload endpoint does not accept, so the
 * caller is the one that decides what is small enough to send.
 */
interface DiscordUpload {
  readonly bytes: Uint8Array;
  readonly filename: string;
  readonly mediaType: string;
}

interface DiscordCommandOption {
  readonly choices?: readonly { readonly name: string; readonly value: number | string }[];
  readonly description: string;
  readonly name: string;
  readonly required: boolean;
  readonly type: number;
}

interface DiscordCommand {
  /** Where the command may be used. Only meaningful on a global publish. */
  readonly contexts?: readonly number[];
  readonly description: string;
  readonly integration_types?: readonly number[];
  readonly name: string;
  readonly options: readonly DiscordCommandOption[];
}

interface DiscordRestOptions {
  /** Overridable so a test can point the client at a local server. */
  readonly baseUrl?: string;
  readonly logger: Logger;
  readonly signal: AbortSignal;
  readonly token: SecretHandle;
}

/**
 * A Discord API error Nox could not retry its way past. `status` is kept because
 * the difference between 401, 403 and 404 is the difference between a bad token,
 * a missing permission and a channel that no longer exists — three different
 * things for an operator to fix.
 */
class DiscordRestError extends Error {
  public readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = 'DiscordRestError';
    this.status = status;
  }
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    function onAbort(): void {
      clearTimeout(timer);
      reject(new Error('Aborted.'));
    }
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * How long to wait before trying again, from whatever Discord said. The header
 * is in seconds and the JSON body is too; both are honored, and a value that is
 * absurd is not waited on inline — a bucket that wants a minute is a failure to
 * report, not a request to hold open.
 */
function retryDelay(response: Response, body: unknown): number | undefined {
  const header = response.headers.get('retry-after');
  const fromBody =
    typeof body === 'object' && body !== null && 'retry_after' in body
      ? Number(body.retry_after)
      : Number.NaN;
  const seconds = Number.isFinite(fromBody) ? fromBody : Number(header);
  if (!Number.isFinite(seconds)) return undefined;

  const ms = Math.ceil(seconds * 1000);
  return ms > MAX_RETRY_WAIT_MS ? undefined : Math.max(ms, 0);
}

/**
 * The slice of Discord's HTTP API this transport uses.
 *
 * Deliberately small and hand-written: what a broker does over REST is post,
 * edit, answer an interaction and publish a command list. Everything else a
 * client library offers — caches, entity models, sharding — would be surface
 * this package never calls, carried in the kernel's dependency tree.
 *
 * Calls are serialized per route key rather than per Discord bucket. Discord's
 * buckets are per channel for messages, which is what the key is, and a broker
 * that posts two chunks of one reply in order is the case worth getting right.
 */
class DiscordRest {
  readonly #base: string;
  readonly #locks = new Map<string, Mutex>();
  readonly #logger: Logger;
  readonly #signal: AbortSignal;
  readonly #token: SecretHandle;

  constructor(options: DiscordRestOptions) {
    this.#base = options.baseUrl ?? API_BASE;
    this.#logger = options.logger;
    this.#signal = options.signal;
    this.#token = options.token;
  }

  /**
   * Whether the bot can reach this channel, by asking Discord for it.
   *
   * The cheapest question that has the same answer as posting: `GET /channels`
   * needs the same reachability a message does, and costs nothing that has to
   * be taken back if the answer is no. 404 and 403 are the two ways an address
   * is wrong — gone, or never visible to this bot — and both are reported as
   * unreachable rather than raised, because a caller checking an address wants
   * a verdict. Every other failure is thrown: not being able to ask is not the
   * same as having asked and been told no.
   */
  public async canReach(channelId: string): Promise<boolean> {
    try {
      await this.#request(`channel:${channelId}`, 'GET', `/channels/${channelId}`, undefined);
      return true;
    } catch (error) {
      if (error instanceof DiscordRestError && (error.status === 403 || error.status === 404)) {
        return false;
      }
      throw error;
    }
  }

  /**
   * Posts a message, and answers with the ID Discord gave it.
   *
   * Files ride along as multipart, which is the only way Discord accepts bytes:
   * `payload_json` carries the message exactly as the JSON form would, and each
   * file is declared in `attachments` under the index it was sent with, which is
   * what ties the two halves of the body together.
   */
  public async createMessage(
    channelId: string,
    payload: DiscordMessagePayload,
    uploads: readonly DiscordUpload[] = [],
  ): Promise<string> {
    const created = await this.#request<{ id: string }>(
      `channel:${channelId}`,
      'POST',
      `/channels/${channelId}/messages`,
      uploads.length === 0 ? payload : multipart(payload, uploads),
    );
    return created?.id ?? '';
  }

  /** Rewrites a message Nox posted: how a prompt is retracted once it is over. */
  public async editMessage(
    channelId: string,
    messageId: string,
    payload: DiscordMessagePayload,
  ): Promise<void> {
    await this.#request(
      `channel:${channelId}`,
      'PATCH',
      `/channels/${channelId}/messages/${messageId}`,
      payload,
    );
  }

  /**
   * Answers an interaction. Every click has to be acknowledged within three
   * seconds or Discord shows the person a failure, so this is called before any
   * work the click implies.
   */
  public async respondToInteraction(
    interactionId: string,
    interactionToken: string,
    payload: { readonly data?: unknown; readonly type: number },
  ): Promise<void> {
    await this.#request(
      `interaction:${interactionId}`,
      'POST',
      `/interactions/${interactionId}/${interactionToken}/callback`,
      payload,
    );
  }

  /**
   * Replaces the command list with exactly this one, in one guild or everywhere.
   * A full replace rather than an incremental update: the catalog is a
   * declaration, so a command Nox no longer offers must stop being offered, and
   * additions without removals is how a palette grows commands that do nothing.
   * The two routes are one method because they are one decision — which of the
   * two a deployment wants is configuration, and nothing below this line
   * differs between them.
   */
  public async publishCommands(
    applicationId: string,
    guildId: string | undefined,
    commands: readonly DiscordCommand[],
  ): Promise<void> {
    await this.#request(
      `commands:${guildId ?? 'global'}`,
      'PUT',
      guildId === undefined
        ? `/applications/${applicationId}/commands`
        : `/applications/${applicationId}/guilds/${guildId}/commands`,
      commands,
    );
  }

  /** Shows the typing indicator; it lapses on its own after about ten seconds. */
  public async triggerTyping(channelId: string): Promise<void> {
    await this.#request(`typing:${channelId}`, 'POST', `/channels/${channelId}/typing`, undefined);
  }

  #lock(key: string): Mutex {
    const existing = this.#locks.get(key);
    if (existing !== undefined) return existing;

    const created = new Mutex();
    this.#locks.set(key, created);
    return created;
  }

  async #request<T>(
    routeKey: string,
    method: 'GET' | 'PATCH' | 'POST' | 'PUT',
    path: string,
    body: unknown,
  ): Promise<T | undefined> {
    return this.#lock(routeKey).run(() => this.#send<T>(method, path, body));
  }

  async #send<T>(
    method: 'GET' | 'PATCH' | 'POST' | 'PUT',
    path: string,
    body: unknown,
  ): Promise<T | undefined> {
    let lastStatus = 0;
    let lastDetail = '';

    // A multipart body carries its own boundary, so the content type is left to
    // `fetch` to write; anything else is JSON. `FormData` is re-encoded on every
    // send, which is what makes a retried upload send its bytes again.
    const form = body instanceof FormData;

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
      const response = await fetch(`${this.#base}${path}`, {
        body: body === undefined ? undefined : form ? body : JSON.stringify(body),
        headers: {
          authorization: `Bot ${this.#token.reveal()}`,
          ...(form ? {} : { 'content-type': 'application/json' }),
        },
        method,
        signal: this.#signal,
      });

      if (response.status === 204) return undefined;
      if (response.ok) return (await response.json()) as T;

      const detail: string = await response.text();
      lastStatus = response.status;
      lastDetail = detail;

      // A rate limit and a Discord-side fault are the two failures that are
      // about *when* rather than *what*. Everything else — a bad token, a
      // missing permission, a channel that is gone — is answered the same way
      // however many times it is asked.
      const retryable = response.status === 429 || response.status >= 500;
      if (!retryable || attempt === MAX_ATTEMPTS) break;

      const delay =
        response.status === 429
          ? retryDelay(response, safeJson(detail))
          : Math.min(2 ** attempt * 250, MAX_RETRY_WAIT_MS);
      if (delay === undefined) break;

      this.#logger.debug(
        { attempt, delay, method, path, status: response.status },
        'Retrying a Discord request.',
      );
      await sleep(delay, this.#signal);
    }

    throw new DiscordRestError(
      lastStatus,
      `Discord answered ${String(lastStatus)} to ${method} ${path}: ${lastDetail.slice(0, 500)}`,
    );
  }
}

/**
 * One message and its files as the body Discord's upload endpoint wants.
 *
 * The index a file is sent under is its ID in `attachments`, and the two have to
 * agree: Discord matches them, and a file whose index is not declared is dropped
 * without an error.
 */
function multipart(payload: DiscordMessagePayload, uploads: readonly DiscordUpload[]): FormData {
  const form = new FormData();
  form.append(
    'payload_json',
    JSON.stringify({
      ...payload,
      attachments: uploads.map((upload, index) => ({ filename: upload.filename, id: index })),
    }),
  );

  uploads.forEach((upload, index) => {
    form.append(
      `files[${String(index)}]`,
      new Blob([upload.bytes], { type: upload.mediaType }),
      upload.filename,
    );
  });

  return form;
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

export { DiscordRest, DiscordRestError, EPHEMERAL, INTERACTION_REPLY, INTERACTION_UPDATE_MESSAGE };

export type {
  DiscordActionRow,
  DiscordButton,
  DiscordCommand,
  DiscordCommandOption,
  DiscordMessagePayload,
  DiscordUpload,
};
