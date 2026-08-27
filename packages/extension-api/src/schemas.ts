import { z } from 'zod';

const IDENTIFIER_PATTERN = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/;

const identifierSchema = z
  .string()
  .trim()
  .min(1)
  .max(214)
  .regex(IDENTIFIER_PATTERN, 'Use a lowercase package-like identifier.');

function assertIdentifier(value: string, kind: string): void {
  const result = identifierSchema.safeParse(value);
  if (!result.success) {
    throw new TypeError(`Invalid ${kind} "${value}": ${result.error.issues[0]?.message ?? ''}`);
  }
}

const localeSchema = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^[a-z]{2,3}(?:-[a-z0-9]{2,8})*$/u, 'Expected a lowercase BCP 47 language tag.');

const instanceIdSchema = z
  .string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/, 'Use letters, digits, dots, dashes or underscores.');
const entryIdSchema = instanceIdSchema.max(64);

const secretIdSchema = z
  .string()
  .max(128, 'Secret IDs cannot exceed 128 characters.')
  .regex(
    /^[A-Za-z0-9][A-Za-z0-9._-]*$/,
    'Use letters, digits, dots, dashes or underscores; paths are not secret IDs.',
  );
const secretRefSchema = z
  .object(
    { $secret: secretIdSchema },
    { error: 'Use a secret reference such as {"$secret":"OPENAI_API_KEY"}.' },
  )
  .readonly()
  .brand<'SecretRef'>();

type SecretRef = z.infer<typeof secretRefSchema>;

interface SecretHandle {
  readonly id: string;
  reveal(): string;
  toJSON(): string;
  toString(): string;
}

const runtimeSecretSchema = z.custom<SecretHandle>(
  (value) =>
    typeof value === 'object' &&
    value !== null &&
    typeof Reflect.get(value, 'id') === 'string' &&
    typeof Reflect.get(value, 'reveal') === 'function',
  'Expected an opaque secret handle supplied by Nox.',
);

function httpUrlSchema(description: string): z.ZodType<string> {
  return z
    .url()
    .refine((value) => isHttp(value), { message: 'Only HTTP and HTTPS URLs are supported.' })
    .refine((value) => !carriesCredentials(value), {
      message:
        'Remove the credentials embedded in this URL; a URL is recorded and logged. ' +
        'Send them through a managed secret instead.',
    })
    .describe(description);
}

function parsedUrl(value: string): undefined | URL {
  try {
    return new URL(value);
  } catch {
    return undefined;
  }
}

function isHttp(value: string): boolean {
  const url = parsedUrl(value);
  return url !== undefined && ['http:', 'https:'].includes(url.protocol);
}

function carriesCredentials(value: string): boolean {
  const url = parsedUrl(value);
  return url !== undefined && (url.username !== '' || url.password !== '');
}

const ianaTimeZoneSchema = z
  .string()
  .trim()
  .min(1)
  .refine((value) => {
    try {
      new Intl.DateTimeFormat('en', { timeZone: value });
      return true;
    } catch {
      return false;
    }
  }, 'Use an IANA time zone name, such as UTC or America/Mexico_City.');

export {
  assertIdentifier,
  entryIdSchema,
  httpUrlSchema,
  ianaTimeZoneSchema,
  identifierSchema,
  instanceIdSchema,
  localeSchema,
  runtimeSecretSchema,
  secretIdSchema,
  secretRefSchema,
};

export type { SecretHandle, SecretRef };
