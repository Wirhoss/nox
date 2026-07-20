function normalizedBaseUrl(url: string): string {
  return url.replace(/\/+$/, '');
}

async function responseError(response: Response): Promise<Error> {
  const detail = (await response.text().catch(() => '')).trim().slice(0, 500);
  return new Error(
    `Web service returned HTTP ${response.status}${detail ? `: ${detail}` : '.'}`,
  );
}

function signalWithTimeout(parent: AbortSignal, timeoutMs: number): AbortSignal {
  return AbortSignal.any([parent, AbortSignal.timeout(timeoutMs)]);
}

export {
  normalizedBaseUrl,
  responseError,
  signalWithTimeout,
};
