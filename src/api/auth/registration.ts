import { randomInt, timingSafeEqual } from 'node:crypto';

import type { Logger } from '../../logger/logger';

/** No 0/O/1/I: the code is read off a terminal and typed into a browser by hand. */
const CODE_ALPHABET = 'ACDEFGHJKLMNPQRTUVWXYZ2346789';
const CODE_GROUPS = 3;
const CODE_GROUP_SIZE = 4;

/**
 * The window between a fresh install and the account that claims it.
 *
 * Without something to close it, whoever reaches the port first owns the Nox —
 * and the compose file publishes that port on every interface. The code is
 * written to the log, which is the one place the person who started the
 * container can read and a stranger on the network cannot.
 *
 * It lives in memory only. A restart before registering prints a new code and
 * invalidates the old one, which is the behaviour worth having: the code is
 * useful for as long as the operator is looking at the terminal.
 */
class RegistrationWindow {
  #code: string | undefined;

  private constructor(code: string) {
    this.#code = code;
  }

  /**
   * Opens a window and announces it. Nothing is printed for a Nox that already
   * has its account — there is no window, and a code in the log of every restart
   * would only teach the operator to ignore it.
   */
  public static open(logger: Logger): RegistrationWindow {
    const window = new RegistrationWindow(generateCode());
    logger.info(
      { code: window.#code },
      'No account exists yet. Register with this code; it stops working once an account is created.',
    );
    return window;
  }

  /** A Nox that is already claimed. It has no code, and there is none to print. */
  public static closed(): RegistrationWindow {
    const window = new RegistrationWindow('');
    window.close();
    return window;
  }

  public get isOpen(): boolean {
    return this.#code !== undefined;
  }

  /**
   * Compared without leaking how much of the code was right. A closed window
   * accepts nothing, including the code it used to hold.
   */
  public accepts(candidate: string): boolean {
    if (this.#code === undefined) return false;

    const expected = Buffer.from(this.#code, 'utf8');
    const actual = Buffer.from(candidate, 'utf8');
    if (expected.length !== actual.length) return false;
    return timingSafeEqual(expected, actual);
  }

  /** Burns the code. Called once registration has actually succeeded, never before. */
  public close(): void {
    this.#code = undefined;
  }
}

/**
 * `randomInt` rather than an index into a random byte, because 256 is not a
 * multiple of the alphabet size and the modulo would quietly favour its first
 * few characters.
 */
function generateCode(): string {
  const groups = Array.from({ length: CODE_GROUPS }, () =>
    Array.from(
      { length: CODE_GROUP_SIZE },
      () => CODE_ALPHABET[randomInt(CODE_ALPHABET.length)] ?? '',
    ).join(''),
  );
  return `NOX-${groups.join('-')}`;
}

export { RegistrationWindow };
