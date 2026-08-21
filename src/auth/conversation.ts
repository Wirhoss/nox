import { principalKey, type PrincipalRef } from './principal';

/**
 * The sticky security state of one session's shared transcript.
 *
 * A principal is observed as soon as an accepted message is queued, not only when
 * the runner eventually drains it into context. That conservative edge is what
 * lets a second speaker release a permission wait that was already blocking the
 * first speaker's run.
 */
class ConversationParticipants {
  readonly #principals = new Set<string>();
  readonly #whenShared: Promise<void>;

  #resolveShared!: () => void;
  #shared = false;

  constructor(initial: Iterable<PrincipalRef> = []) {
    this.#whenShared = new Promise<void>((resolve) => {
      this.#resolveShared = resolve;
    });
    for (const principal of initial) this.observe(principal);
  }

  public get isShared(): boolean {
    return this.#shared;
  }

  /** Resolves once, at the first transition from one principal to more than one. */
  public get whenShared(): Promise<void> {
    return this.#whenShared;
  }

  public observe(principal: PrincipalRef): void {
    if (this.#shared) return;

    this.#principals.add(principalKey(principal));
    if (this.#principals.size > 1) {
      this.#shared = true;
      this.#resolveShared();
    }
  }
}

export { ConversationParticipants };
