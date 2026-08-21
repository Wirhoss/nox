/** The error carried by an aborted operation, normalized when no Error reason exists. */
function abortError(signal: AbortSignal): Error {
  const reason: unknown = signal.reason;
  return reason instanceof Error
    ? reason
    : new DOMException('The operation was aborted', 'AbortError');
}

/**
 * Starts an operation only while its signal is live and stops awaiting it on abort.
 *
 * The operation receives the signal separately through its own API so cooperative
 * implementations can stop their work. This race is the backstop for implementations
 * that ignore it: their eventual rejection is still observed by the attached handler,
 * but it cannot keep the caller alive or resume the abandoned decision.
 */
function raceWithAbort<T>(signal: AbortSignal, operation: () => PromiseLike<T> | T): Promise<T> {
  if (signal.aborted) return Promise.reject(abortError(signal));

  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const onAbort = (): void => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', onAbort);
      reject(abortError(signal));
    };

    signal.addEventListener('abort', onAbort, { once: true });
    // Close the small gap between the initial check and listener registration.
    if (signal.aborted) {
      onAbort();
      return;
    }

    let pending: PromiseLike<T> | T;
    try {
      pending = operation();
    } catch (error) {
      settled = true;
      signal.removeEventListener('abort', onAbort);
      reject(error instanceof Error ? error : new Error(String(error)));
      return;
    }

    void Promise.resolve(pending).then(
      (value) => {
        if (settled) return;
        settled = true;
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (error: unknown) => {
        if (settled) return;
        settled = true;
        signal.removeEventListener('abort', onAbort);
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
}

export { raceWithAbort };
