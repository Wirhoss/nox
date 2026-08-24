import type { SecretHandle } from '../../../../config/secrets';

/**
 * What every module does to reach its service, in one place.
 *
 * The service-specific part of a module is its routes and its payloads, not its
 * plumbing: the same timeout handling, the same bearer header, the same refusal
 * to let a 500 arrive as an unreadable parse failure. Sharing it here is what
 * keeps a second module from being a rewrite of the first.
 */

interface WebServiceOptions {
  readonly apiKey?: SecretHandle;
  readonly timeoutMs: number;
  readonly url: string;
}

interface WebRequestOptions {
  readonly body?: unknown;
  readonly method?: 'DELETE' | 'GET' | 'POST';
  readonly query?: Readonly<Record<string, number | string | undefined>>;
  readonly signal: AbortSignal;
  /** Overrides the configured timeout for one call, for waits the caller sized. */
  readonly timeoutMs?: number;
}

/**
 * A service answered, and the answer is not the one the caller can act on.
 *
 * The detail is the service's own words where it wrote any. A camofox 409 says
 * the page moved and that the fix is a fresh snapshot; that sentence is worth
 * more to whoever reads the failure — a model retrying, an operator in a log —
 * than the JSON envelope it arrived in.
 */
class WebServiceError extends Error {
  /** The machine-readable reason, where the service names one. */
  public readonly code?: string;
  public readonly detail: string;
  public readonly status: number;

  constructor(service: string, status: number, refusal: Refusal) {
    super(
      `${service} returned HTTP ${String(status)}${
        refusal.detail.length > 0 ? `: ${refusal.detail}` : '.'
      }`,
    );
    this.name = 'WebServiceError';
    this.detail = refusal.detail;
    this.status = status;
    if (refusal.code !== undefined) this.code = refusal.code;
  }
}

interface Refusal {
  readonly code?: string;
  readonly detail: string;
}

/**
 * A refusal read as far as it can be: the words a person can act on, and the
 * code a caller can branch on.
 *
 * Keeping the code is what lets a module answer the caller's real question. A
 * service's own sentence can be wrong about the cause — camofox says a page
 * changed when a CSS selector simply matched nothing — and only the module knows
 * enough about the call it made to say which it was.
 */
function refusalOf(body: string): Refusal {
  const trimmed = body.trim();
  if (!trimmed.startsWith('{')) return { detail: trimmed.slice(0, 500) };

  try {
    const parsed = JSON.parse(trimmed) as Record<string, unknown>;
    const spoken = [parsed.error, parsed.message, parsed.hint, parsed.detail].filter(
      (value): value is string => typeof value === 'string' && value.length > 0,
    );
    return {
      ...(typeof parsed.code === 'string' && parsed.code.length > 0 ? { code: parsed.code } : {}),
      detail:
        spoken.length === 0 ? trimmed.slice(0, 500) : [...new Set(spoken)].join(' ').slice(0, 500),
    };
  } catch {
    return { detail: trimmed.slice(0, 500) };
  }
}

/**
 * One configured HTTP service. It holds the credential rather than passing it
 * around: a handle that never leaves this object cannot be logged, echoed in a
 * risk record, or copied into a request that was going somewhere else.
 */
class WebService {
  readonly #apiKey?: SecretHandle;
  readonly #name: string;
  readonly #timeoutMs: number;
  readonly #url: string;

  constructor(name: string, options: WebServiceOptions) {
    this.#name = name;
    this.#timeoutMs = options.timeoutMs;
    this.#url = options.url.replace(/\/+$/, '');
    if (options.apiKey !== undefined) this.#apiKey = options.apiKey;
  }

  public get origin(): string {
    return this.#url;
  }

  /**
   * The JSON body of a successful call, or a `WebServiceError` naming the status.
   *
   * An empty 200 is a body, not a failure: services answer some calls with
   * nothing at all, and turning that into a parse error would report a tab that
   * closed cleanly as a broken service.
   */
  public async json<T>(path: string, options: WebRequestOptions): Promise<T> {
    const response = await this.fetch(path, options);
    const body = (await response.text()).trim();
    if (body.length === 0) return {} as T;

    try {
      return JSON.parse(body) as T;
    } catch (error) {
      throw new Error(`${this.#name} answered ${path} with something that is not JSON.`, {
        cause: error,
      });
    }
  }

  /**
   * The bytes of a successful call, with the type the service declared.
   *
   * Binary answers are not an edge case to be discovered at runtime: a
   * screenshot route may return a PNG directly or a base64 field inside JSON,
   * and which one it is belongs to the module that knows the service — so this
   * hands back both the bytes and what they were labelled.
   */
  public async bytes(
    path: string,
    options: WebRequestOptions,
  ): Promise<{ bytes: Uint8Array; mediaType: string }> {
    const response = await this.fetch(path, options);
    const mediaType = (response.headers.get('content-type') ?? '').split(';')[0]?.trim() ?? '';
    return { bytes: new Uint8Array(await response.arrayBuffer()), mediaType };
  }

  public async fetch(path: string, options: WebRequestOptions): Promise<Response> {
    const url = new URL(`${this.#url}${path}`);
    for (const [key, value] of Object.entries(options.query ?? {})) {
      if (value !== undefined) url.searchParams.set(key, String(value));
    }

    const timeoutMs = options.timeoutMs ?? this.#timeoutMs;
    const response = await fetch(url, {
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
      headers: {
        Accept: 'application/json, */*;q=0.8',
        ...(options.body === undefined ? {} : { 'Content-Type': 'application/json' }),
        ...(this.#apiKey === undefined ? {} : { Authorization: `Bearer ${this.#apiKey.reveal()}` }),
      },
      method: options.method ?? (options.body === undefined ? 'GET' : 'POST'),
      signal: AbortSignal.any([options.signal, AbortSignal.timeout(timeoutMs)]),
    });

    if (!response.ok) {
      throw new WebServiceError(
        this.#name,
        response.status,
        refusalOf(await response.text().catch(() => '')),
      );
    }
    return response;
  }
}

/**
 * A URL a page pointed at, resolved against the page and cleared for use, or
 * nothing.
 *
 * Everything a crawl reports is attacker-controlled text: a page decides what
 * its own markup says. So a src is only usable once it is absolute, HTTP(S), and
 * carries no userinfo — the same rule configuration is held to, applied to the
 * addresses a page hands back.
 */
function publicUrl(value: string, base?: string): string | undefined {
  try {
    const url = base === undefined ? new URL(value) : new URL(value, base);
    if (!['http:', 'https:'].includes(url.protocol)) return undefined;
    if (url.username.length > 0 || url.password.length > 0) return undefined;
    return url.href;
  } catch {
    return undefined;
  }
}

/**
 * Whether an address belongs to this machine or to the network it sits on.
 *
 * This matters for exactly one thing here: the pictures a page points at are
 * fetched by Nox itself, from inside whatever network Nox runs in. A page that
 * names `http://169.254.169.254/…` or a neighbour's admin port would otherwise
 * have Nox read it and publish the answer as a file — the page choosing what
 * Nox looks at. Names that resolve to private space later are not caught here;
 * this refuses the ones that say so up front, which is the cheap half.
 */
function isPrivateHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/gu, '');
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.internal'))
    return true;
  if (host === '::1' || host === '::' || host.startsWith('fc') || host.startsWith('fd'))
    return true;
  if (host.startsWith('fe80:')) return true;

  const octets = host.split('.');
  if (octets.length !== 4) return false;
  const numbers = octets.map((octet) => Number(octet));
  if (numbers.some((value) => !Number.isInteger(value) || value < 0 || value > 255)) return false;

  const [first = 0, second = 0] = numbers;
  if (first === 0 || first === 10 || first === 127) return true;
  if (first === 169 && second === 254) return true;
  if (first === 172 && second >= 16 && second <= 31) return true;
  if (first === 192 && second === 168) return true;
  return false;
}

/** Base64 as bytes, or nothing when a service sent something that is not. */
function decodeBase64(value: string): Uint8Array | undefined {
  try {
    const trimmed = value.startsWith('data:') ? (value.split(',')[1] ?? '') : value;
    const binary = atob(trimmed);
    return Uint8Array.from(binary, (character) => character.codePointAt(0) ?? 0);
  } catch {
    return undefined;
  }
}

export { decodeBase64, isPrivateHost, publicUrl, WebService, WebServiceError };

export type { WebRequestOptions, WebServiceOptions };
