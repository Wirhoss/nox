import type { Logger, SecretHandle } from '@nox/extension-api';

/**
 * What the bot asks Discord to send it. Two of these are privileged and have to
 * be enabled on the application.
 *
 * `MESSAGE_CONTENT`, or every message arrives with an empty body and the ingress
 * rule passes on nothing at all.
 *
 * `GUILD_MEMBERS`, because grants and `senders` can be written against roles:
 * role IDs ride on every message, and this intent buys `GUILD_MEMBER_UPDATE`,
 * the only way losing a role takes effect before its holder speaks again —
 * authority that outlives the role it came from is the failure worth an extra
 * intent. Nothing else is requested: presence and the rest would be traffic
 * this transport receives and drops.
 */
const INTENT_GUILDS = 1 << 0;
const INTENT_GUILD_MEMBERS = 1 << 1;
const INTENT_GUILD_MESSAGES = 1 << 9;
const INTENT_DIRECT_MESSAGES = 1 << 12;
const INTENT_MESSAGE_CONTENT = 1 << 15;
const INTENTS =
  INTENT_GUILDS |
  INTENT_GUILD_MEMBERS |
  INTENT_GUILD_MESSAGES |
  INTENT_DIRECT_MESSAGES |
  INTENT_MESSAGE_CONTENT;

const OP_DISPATCH = 0;
const OP_HEARTBEAT = 1;
const OP_IDENTIFY = 2;
const OP_RESUME = 6;
const OP_RECONNECT = 7;
const OP_INVALID_SESSION = 9;
const OP_HELLO = 10;
const OP_HEARTBEAT_ACK = 11;

const DEFAULT_GATEWAY = 'wss://gateway.discord.gg/?v=10&encoding=json';

/**
 * Close codes Discord will answer identically however many times it is asked.
 * A bad token, an intent the application was never granted and a gateway version
 * that no longer exists are configuration, not weather: reconnecting on a loop
 * would turn one fixable problem into a permanent one nobody can see.
 */
const FATAL_CLOSE_CODES = new Set([4004, 4010, 4011, 4012, 4013, 4014]);

/** How long a first connection may take before it is called a failure. */
const READY_TIMEOUT_MS = 30_000;

const MIN_BACKOFF_MS = 1_000;
const MAX_BACKOFF_MS = 60_000;

interface DiscordIdentity {
  /** Every server Discord reported this bot belongs to when the session became ready. */
  readonly guildIds: readonly string[];
  readonly id: string;
  readonly username: string;
}

interface DiscordSocketOptions {
  /** Overridable so a test can point the socket at a local server. */
  readonly gatewayUrl?: string;
  readonly logger: Logger;
  /** One dispatched gateway event. Never throws back into the socket. */
  readonly onDispatch: (type: string, data: Record<string, unknown>) => void;
  readonly signal: AbortSignal;
  readonly token: SecretHandle;
}

interface GatewayFrame {
  readonly d?: unknown;
  readonly op: number;
  readonly s?: null | number;
  readonly t?: null | string;
}

class DiscordSocketError extends Error {
  /** Present when Discord closed the connection with a code. */
  public readonly code?: number;

  constructor(message: string, code?: number) {
    super(message);
    this.name = 'DiscordSocketError';
    if (code !== undefined) this.code = code;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/**
 * The Discord gateway connection: identify, heartbeat, resume, reconnect.
 *
 * It knows nothing about Nox. It hands dispatched events to its owner and keeps
 * itself connected, which is the whole of its job — the broker above decides
 * what any of them mean.
 *
 * The lifecycle it implements is Discord's, and the parts that look fussy are
 * the parts that matter in practice: a heartbeat that is never acknowledged
 * means the connection is dead while still looking open, and a resume that is
 * refused means the session is gone and the next identify has to be a fresh one.
 */
class DiscordSocket {
  readonly #logger: Logger;
  readonly #onDispatch: DiscordSocketOptions['onDispatch'];
  readonly #signal: AbortSignal;
  readonly #token: SecretHandle;
  readonly #url: string;

  #acknowledged = true;
  #attempt = 0;
  #closing = false;
  #heartbeat?: ReturnType<typeof setInterval>;
  /** The delay before the first beat, which must be cancellable on its own. */
  #heartbeatStart?: ReturnType<typeof setTimeout>;
  #identity?: DiscordIdentity;
  #pending?: { reject: (error: Error) => void; resolve: (identity: DiscordIdentity) => void };
  /** A reconnection that has been scheduled and not yet attempted. */
  #reconnectTimer?: ReturnType<typeof setTimeout>;
  #resumeUrl?: string;
  #sequence: null | number = null;
  #sessionId?: string;
  #socket?: WebSocket;

  constructor(options: DiscordSocketOptions) {
    this.#logger = options.logger;
    this.#onDispatch = options.onDispatch;
    this.#signal = options.signal;
    this.#token = options.token;
    this.#url = options.gatewayUrl ?? DEFAULT_GATEWAY;
  }

  /** Who Discord says this bot is, once it has said so. */
  public get identity(): DiscordIdentity | undefined {
    return this.#identity;
  }

  /**
   * Opens the connection and resolves when Discord says the bot is ready.
   *
   * The first connection is awaited rather than left to settle in the
   * background: a broker that reported itself started while it was still failing
   * to log in would leave a Nox believing it is reachable on a channel it never
   * joined. Afterwards the socket keeps itself up on its own, and a drop is
   * weather rather than a failure to report.
   */
  public connect(): Promise<DiscordIdentity> {
    return new Promise<DiscordIdentity>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#settle(new DiscordSocketError('Discord did not become ready in time.'));
      }, READY_TIMEOUT_MS);

      this.#pending = {
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
        resolve: (identity) => {
          clearTimeout(timer);
          resolve(identity);
        },
      };

      this.#open();
    });
  }

  /** Closes for good. A socket that was told to stop never reconnects. */
  public close(): void {
    this.#closing = true;
    this.#stopHeartbeat();
    if (this.#reconnectTimer !== undefined) clearTimeout(this.#reconnectTimer);
    this.#reconnectTimer = undefined;
    this.#settle(new DiscordSocketError('The Discord socket was closed.'));

    const socket = this.#socket;
    this.#socket = undefined;
    // 1000 tells Discord this session is over, so it is not held for a resume
    // that is never coming.
    try {
      socket?.close(1000, 'Nox is shutting down.');
    } catch (error) {
      this.#logger.debug({ err: error }, 'Closing the Discord socket threw.');
    }
  }

  #open(): void {
    if (this.#closing || this.#signal.aborted) return;

    const resuming = this.#sessionId !== undefined && this.#resumeUrl !== undefined;
    const url = resuming ? `${this.#resumeUrl ?? ''}?v=10&encoding=json` : this.#url;
    this.#acknowledged = true;

    let socket: WebSocket;
    try {
      socket = new WebSocket(url);
    } catch (error) {
      this.#logger.warn({ err: error }, 'Could not open the Discord socket.');
      this.#scheduleReconnect();
      return;
    }
    this.#socket = socket;

    socket.addEventListener('message', (event: MessageEvent) => {
      // A listener is the end of the line: nothing above it can catch what it
      // throws, so a fault while handling one frame would leave the process
      // with an uncaught exception instead of leaving Nox with a broker that
      // failed to start. Failing the pending connect is what turns it back into
      // an ordinary startup failure the gateway already knows how to report.
      try {
        this.#receive(event.data);
      } catch (error) {
        this.#logger.error({ err: error }, 'Handling a Discord gateway frame threw.');
        this.#settle(
          error instanceof Error ? error : new DiscordSocketError('A gateway frame threw.'),
        );
      }
    });
    socket.addEventListener('error', () => {
      // The close event carries the code and always follows; logging here as
      // well would report one drop twice.
      this.#logger.debug({}, 'The Discord socket reported an error.');
    });
    socket.addEventListener('close', (event: CloseEvent) => {
      this.#onClose(event.code, event.reason);
    });
  }

  #receive(raw: unknown): void {
    if (typeof raw !== 'string') return;

    let frame: GatewayFrame;
    try {
      frame = JSON.parse(raw) as GatewayFrame;
    } catch (error) {
      this.#logger.warn({ err: error }, 'Discord sent a frame that is not JSON.');
      return;
    }

    if (typeof frame.s === 'number') this.#sequence = frame.s;

    switch (frame.op) {
      case OP_DISPATCH:
        this.#dispatch(frame);
        break;
      case OP_HEARTBEAT:
        this.#send({ d: this.#sequence, op: OP_HEARTBEAT });
        break;
      case OP_HEARTBEAT_ACK:
        this.#acknowledged = true;
        break;
      case OP_HELLO:
        this.#onHello(frame.d);
        break;
      case OP_INVALID_SESSION:
        // `d: true` means the session may still be resumed. Anything else means
        // it is gone, and identifying again with a stale session ID would be
        // refused the same way.
        if (frame.d !== true) this.#forgetSession();
        this.#reconnect(1000);
        break;
      case OP_RECONNECT:
        this.#reconnect(500);
        break;
      default:
        this.#logger.debug({ op: frame.op }, 'Ignored an unknown gateway opcode.');
        break;
    }
  }

  #onHello(data: unknown): void {
    const interval =
      isRecord(data) && typeof data.heartbeat_interval === 'number' ? data.heartbeat_interval : 0;
    if (interval <= 0) {
      this.#logger.warn({}, 'Discord sent no heartbeat interval.');
      this.#reconnect(MIN_BACKOFF_MS);
      return;
    }

    // Discord asks for the first beat to be offset by a random fraction of the
    // interval, so a fleet of bots reconnecting after an outage does not arrive
    // in one wave.
    const first = Math.floor(interval * Math.random());
    // Held and cancellable: a connection closed inside this delay would
    // otherwise start an interval nobody is left holding a handle to, and the
    // socket would keep beating at a gateway it is no longer talking to.
    this.#heartbeatStart = setTimeout(() => {
      this.#heartbeatStart = undefined;
      if (this.#closing) return;

      this.#beat();
      this.#heartbeat = setInterval(() => {
        this.#beat();
      }, interval);
    }, first);

    if (this.#sessionId !== undefined) {
      this.#send({
        d: { seq: this.#sequence, session_id: this.#sessionId, token: this.#token.reveal() },
        op: OP_RESUME,
      });
      return;
    }

    this.#send({
      d: {
        intents: INTENTS,
        properties: { browser: 'nox', device: 'nox', os: process.platform },
        token: this.#token.reveal(),
      },
      op: OP_IDENTIFY,
    });
  }

  /**
   * One heartbeat. A beat sent while the previous one is still unacknowledged
   * means the connection is a zombie — open as far as the socket is concerned,
   * and reaching nobody — so it is dropped and resumed rather than trusted.
   */
  #beat(): void {
    if (!this.#acknowledged) {
      this.#logger.warn({}, 'Discord stopped acknowledging heartbeats; reconnecting.');
      this.#stopHeartbeat();
      this.#socket?.close(4000, 'Heartbeat was not acknowledged.');
      return;
    }

    this.#acknowledged = false;
    this.#send({ d: this.#sequence, op: OP_HEARTBEAT });
  }

  #dispatch(frame: GatewayFrame): void {
    const type = frame.t ?? '';
    const data = isRecord(frame.d) ? frame.d : {};

    if (type === 'READY') {
      const user = isRecord(data.user) ? data.user : {};
      const identity: DiscordIdentity = {
        guildIds: Array.isArray(data.guilds)
          ? data.guilds.flatMap((guild) =>
              isRecord(guild) && typeof guild.id === 'string' ? [guild.id] : [],
            )
          : [],
        id: typeof user.id === 'string' ? user.id : '',
        username: typeof user.username === 'string' ? user.username : '',
      };
      this.#identity = identity;
      this.#sessionId = typeof data.session_id === 'string' ? data.session_id : undefined;
      this.#resumeUrl =
        typeof data.resume_gateway_url === 'string' ? data.resume_gateway_url : undefined;
      this.#attempt = 0;
      this.#pending?.resolve(identity);
      this.#pending = undefined;
      this.#logger.info({ username: identity.username }, 'Connected to Discord.');
      return;
    }

    if (type === 'RESUMED') {
      this.#attempt = 0;
      this.#logger.info({}, 'Resumed the Discord session.');
      return;
    }

    try {
      this.#onDispatch(type, data);
    } catch (error) {
      // A transport handing over what arrived is not where a failure above it is
      // handled; the socket stays up.
      this.#logger.error({ err: error, event: type }, 'Handling a Discord event failed.');
    }
  }

  #onClose(code: number, reason: string): void {
    this.#stopHeartbeat();
    this.#socket = undefined;
    if (this.#closing) return;

    if (FATAL_CLOSE_CODES.has(code)) {
      const error = new DiscordSocketError(
        `Discord refused the connection (${String(code)}): ${reason}. ` +
          'Check the bot token and that the Message Content intent is enabled.',
        code,
      );
      this.#logger.error({ code, reason }, 'Discord refused the connection; not reconnecting.');
      this.#closing = true;
      this.#settle(error);
      return;
    }

    // 4007 and 4009 mean the session cannot be resumed: the sequence Nox holds
    // is wrong, or the session timed out. Keeping either would have every
    // reconnection refused for the same reason.
    if (code === 4007 || code === 4009) this.#forgetSession();

    this.#logger.warn({ code, reason }, 'The Discord connection dropped; reconnecting.');
    this.#scheduleReconnect();
  }

  #reconnect(delay: number): void {
    this.#stopHeartbeat();
    const socket = this.#socket;
    this.#socket = undefined;
    socket?.close(4000, 'Reconnecting.');
    this.#reconnectTimer = setTimeout(() => {
      this.#reconnectTimer = undefined;
      this.#open();
    }, delay);
  }

  #scheduleReconnect(): void {
    if (this.#closing || this.#signal.aborted) return;

    this.#attempt += 1;
    const backoff = Math.min(MIN_BACKOFF_MS * 2 ** (this.#attempt - 1), MAX_BACKOFF_MS);
    // Jittered for the same reason the first heartbeat is.
    const delay = backoff / 2 + Math.random() * (backoff / 2);
    this.#reconnectTimer = setTimeout(() => {
      this.#reconnectTimer = undefined;
      this.#open();
    }, delay);
  }

  #forgetSession(): void {
    this.#sessionId = undefined;
    this.#resumeUrl = undefined;
    this.#sequence = null;
  }

  #stopHeartbeat(): void {
    if (this.#heartbeat !== undefined) clearInterval(this.#heartbeat);
    if (this.#heartbeatStart !== undefined) clearTimeout(this.#heartbeatStart);
    this.#heartbeat = undefined;
    this.#heartbeatStart = undefined;
  }

  /** Fails a connect() that is still waiting. Later calls are no-ops. */
  #settle(error: Error): void {
    this.#pending?.reject(error);
    this.#pending = undefined;
  }

  #send(frame: { d: unknown; op: number }): void {
    const socket = this.#socket;
    if (socket?.readyState !== WebSocket.OPEN) return;

    try {
      socket.send(JSON.stringify(frame));
    } catch (error) {
      this.#logger.warn({ err: error, op: frame.op }, 'Could not send a gateway frame.');
    }
  }
}

export { DiscordSocket, DiscordSocketError, INTENTS };

export type { DiscordIdentity, DiscordSocketOptions };
