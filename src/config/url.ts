import { z } from 'zod';

/**
 * An HTTP(S) URL that configuration is allowed to name.
 *
 * Rejecting userinfo — the `user:password@` a URL may carry — is a secrets rule
 * rather than a stylistic one. Everything else in configuration treats a
 * credential as something that cannot be written inline: `apiKey` accepts a
 * `{"$secret":"..."}` reference and refuses a literal, so the value lives
 * encrypted and reaches an adapter as an opaque handle that redacts itself.
 *
 * A URL is the hole in that. It is not a credential field, so nothing stops one
 * being embedded in it, and unlike a handle it is deliberately echoed: it names
 * the resource in a tool's risk record, which is persisted with the decision and
 * shown to whoever approves it, and it is logged when a request never reaches
 * its endpoint. A credential written there would be copied to exactly the places
 * the secret store exists to keep it out of.
 *
 * So the rule is refusal rather than redaction. There is a correct way to send
 * one — declare the secret, reference it, let it arrive as a handle — and the
 * error says so, because silently stripping the userinfo would produce a URL
 * that no longer authenticates and a failure nobody could explain.
 */
function httpUrlSchema(description: string): z.ZodType<string> {
  return z
    .url()
    .refine((value) => isHttp(value), {
      message: 'Only HTTP and HTTPS URLs are supported.',
    })
    .refine((value) => !carriesCredentials(value), {
      message:
        'Remove the credentials embedded in this URL; a URL is recorded and logged. ' +
        'Send them through a managed secret instead.',
    })
    .describe(description);
}

/**
 * Parsed defensively because refinements still run after `z.url()` has already
 * rejected the value: constructing a `URL` from the malformed string would throw
 * out of the validator, turning a config error an operator can read into a crash.
 */
function parsed(value: string): undefined | URL {
  try {
    return new URL(value);
  } catch {
    return undefined;
  }
}

function isHttp(value: string): boolean {
  const url = parsed(value);
  return url !== undefined && ['http:', 'https:'].includes(url.protocol);
}

/** Unparseable is not "no credentials"; it is a failure the first rule reports. */
function carriesCredentials(value: string): boolean {
  const url = parsed(value);
  return url !== undefined && (url.username !== '' || url.password !== '');
}

export { httpUrlSchema };
