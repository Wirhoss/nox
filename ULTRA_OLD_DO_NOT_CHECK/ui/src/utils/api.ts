/*
 * Single fetch wrapper for the Nox REST API.
 *
 * Every workbench previously carried its own copy of this function. The one
 * behaviour worth keeping consistent is the error path: the gateway reports
 * failures as `{ error: { message } }`, but some routes return a bare
 * `{ message }`, so both shapes are unwrapped before falling back to status.
 */

type ApiError = { error?: { message?: string }; message?: string };

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...init,
    headers: {
      accept: 'application/json',
      ...(init?.body ? { 'content-type': 'application/json' } : {}),
      ...init?.headers,
    },
  });
  if (!response.ok) {
    let body: ApiError = {};
    try {
      body = (await response.json()) as ApiError;
    } catch {
      /* use status fallback */
    }
    throw new Error(body.error?.message ?? body.message ?? `${response.status} ${response.statusText}`);
  }
  return (response.status === 204 ? undefined : await response.json()) as T;
}

/** Narrows an unknown catch binding to a message, with a caller-supplied fallback. */
function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

export {
  errorMessage,
  request,
};

export type {
  ApiError,
};
