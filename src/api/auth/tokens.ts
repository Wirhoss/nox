import { createHash, randomBytes } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { jwtVerify, SignJWT } from 'jose';

const SIGNING_KEY_BYTES = 32;
const SIGNING_KEY_FILE = '.auth-key';
const REFRESH_TOKEN_BYTES = 32;

/**
 * Pinned, not read from the token. Accepting whatever a token's own header
 * claims is how `alg` confusion works; `jwtVerify` is told the one algorithm
 * this Nox signs with and rejects everything else.
 */
const ALGORITHM = 'HS256';
const AUDIENCE = 'nox.api';
const ISSUER = 'nox';

/** Who a valid access token says is asking, and under which login. */
interface AccessClaims {
  readonly accountId: string;
  readonly sessionId: string;
}

/** A refresh token and the only form of it that is ever written down. */
interface RefreshToken {
  readonly hash: string;
  readonly token: string;
}

/**
 * Signs the claim that a login happened. It deliberately says nothing about
 * whether that login is still wanted — `sid` is there so the guard can ask the
 * database that question, which is the part a signature cannot answer.
 */
async function signAccessToken(
  claims: AccessClaims,
  key: Uint8Array,
  ttlSeconds: number,
): Promise<string> {
  return new SignJWT({ sid: claims.sessionId })
    .setProtectedHeader({ alg: ALGORITHM })
    .setSubject(claims.accountId)
    .setIssuedAt()
    .setIssuer(ISSUER)
    .setAudience(AUDIENCE)
    .setExpirationTime(`${String(ttlSeconds)}s`)
    .sign(key);
}

/**
 * Undefined for every way a token can fail to be one: bad signature, expired,
 * wrong issuer, missing `sid`. The caller gets no detail because the caller has
 * nothing useful to do with it — all of them are the same 401, and saying which
 * one only helps whoever is guessing.
 */
async function verifyAccessToken(
  token: string,
  key: Uint8Array,
): Promise<AccessClaims | undefined> {
  try {
    const { payload } = await jwtVerify(token, key, {
      algorithms: [ALGORITHM],
      audience: AUDIENCE,
      issuer: ISSUER,
    });
    const { sid, sub } = payload;
    if (typeof sid !== 'string' || typeof sub !== 'string') return undefined;
    return { accountId: sub, sessionId: sid };
  } catch {
    return undefined;
  }
}

/** The value handed to the client, alongside the digest that stands in for it in storage. */
function mintRefreshToken(): RefreshToken {
  const token = randomBytes(REFRESH_TOKEN_BYTES).toString('base64url');
  return { hash: hashRefreshToken(token), token };
}

/**
 * SHA-256 with no salt or stretching, on purpose: this is a 256-bit random
 * value, not a password. There is no dictionary to try, so the slow hashing that
 * protects a guessable secret would only slow down every request that presents
 * a legitimate one.
 */
function hashRefreshToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

/**
 * The installation's signing key, generated once and kept out of the database
 * so that a copy of the database file is not enough to mint tokens.
 *
 * Losing it is recoverable in the only way that matters: every issued token
 * stops verifying and everyone signs in again. That is why this — unlike the
 * secret store's master key, which protects values that cannot be regenerated —
 * writes a fresh key instead of refusing to start.
 */
async function loadOrCreateSigningKey(dataDirectory: string): Promise<Uint8Array> {
  await mkdir(dataDirectory, { recursive: true });
  const keyPath = join(dataDirectory, SIGNING_KEY_FILE);

  try {
    return validateSigningKey(await readFile(keyPath), keyPath);
  } catch (error) {
    if (!isMissingFile(error)) throw error;
  }

  const generated = randomBytes(SIGNING_KEY_BYTES);
  try {
    await writeFile(keyPath, generated, { flag: 'wx', mode: 0o600 });
    return generated;
  } catch (error) {
    // Another process may have initialized the same installation first.
    if (!isExistingFile(error)) throw error;
    return validateSigningKey(await readFile(keyPath), keyPath);
  }
}

function validateSigningKey(value: Buffer, keyPath: string): Uint8Array {
  if (value.length !== SIGNING_KEY_BYTES) {
    throw new Error(`Auth signing key at ${keyPath} must contain exactly 32 bytes.`);
  }
  return new Uint8Array(value);
}

function isMissingFile(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT';
}

function isExistingFile(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'EEXIST';
}

export {
  hashRefreshToken,
  loadOrCreateSigningKey,
  mintRefreshToken,
  signAccessToken,
  verifyAccessToken,
};

export type { AccessClaims, RefreshToken };
