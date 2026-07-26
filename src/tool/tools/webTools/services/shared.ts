import { createLogger } from '../../../../logger';

/** Shared by every web service so their calls land under one module name. */
const webServiceLogger = createLogger('tool:web');

function normalizedBaseUrl(url: string): string {
  return url.replace(/\/+$/, '');
}

async function responseError(response: Response): Promise<Error> {
  const detail = (await response.text().catch(() => '')).trim().slice(0, 500);
  // Every web service funnels its failures through here, so this is the one
  // place that sees which endpoint rejected the call and why.
  webServiceLogger.error(
    { detail, status: response.status, url: response.url },
    'Web service request failed.',
  );
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
  webServiceLogger,
};
