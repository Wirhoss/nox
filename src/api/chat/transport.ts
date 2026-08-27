import type { ChatSurfaceHub, ChatTransport } from '@nox/extension-api';

/** The host slot occupied by Nox's browser transport while its extension is active. */
class ChatHub implements ChatSurfaceHub {
  #transport: ChatTransport | undefined;

  public get transport(): ChatTransport | undefined {
    return this.#transport;
  }

  /** Attaches until the returned function is called; the HTTP surface has exactly one slot. */
  public attach(transport: ChatTransport): () => void {
    if (this.#transport !== undefined) {
      throw new Error('The HTTP chat surface already has its internal transport attached.');
    }
    this.#transport = transport;

    return (): void => {
      if (this.#transport === transport) this.#transport = undefined;
    };
  }
}

export { ChatHub };
