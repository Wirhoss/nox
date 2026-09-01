/**
 * An extension body, for the transport tests. Deliberately not a real Nox
 * extension: what is under test is that a call reaches another process and
 * comes back, not what the contract puts on the other side of it.
 */
export default {
  crash: (): never => {
    process.exit(3);
  },
  echo: (value: unknown): unknown => value,
  slowly: async (ms: number): Promise<string> => {
    await Bun.sleep(ms);
    return `waited ${String(ms)}`;
  },
  throws: (message: string): never => {
    const error = new TypeError(message);
    error.name = 'DeliberateError';
    throw error;
  },
};
