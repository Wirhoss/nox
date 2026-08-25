import { z } from 'zod';

import { SecretHandle, secretRefSchema } from '../../../../config/secrets';
import { httpUrlSchema } from '../../../../config/url';

import type { BrowserCapability, ExtractCapability, SearchCapability } from './capabilities';

/**
 * The three things this tool set can be given, and what filling one produces.
 * A slot is not a tool: `browser` is a family of tools over one capability,
 * while an empty slot contributes no tools at all to the agents holding this
 * instance.
 */
interface SlotCapabilities {
  browser: BrowserCapability;
  extract: ExtractCapability;
  search: SearchCapability;
}

const WEB_SLOTS = ['browser', 'extract', 'search'] as const;

type WebSlot = (typeof WEB_SLOTS)[number];

/**
 * Both shapes a credential position takes: a `{"$secret":"..."}` reference in
 * the stored configuration, an opaque handle in the runtime configuration a
 * module is built from. A module declares its fields once as a function of this,
 * and is built twice over it, so the two forms cannot drift apart.
 */
type CredentialSchema = typeof secretRefSchema | z.ZodType<SecretHandle>;

const storedCredentialSchema = secretRefSchema;
const runtimeCredentialSchema: z.ZodType<SecretHandle> = z.instanceof(SecretHandle);

/** Validated config, seen by the registry with the module's own types erased. */
type WebModuleConfig = Readonly<Record<string, unknown>>;

/** A filled slot: the module it names, and whatever that module's fields parsed to. */
type SlotConfig = Readonly<Record<string, unknown>> & { readonly module: string };

/**
 * One backing implementation of one slot.
 *
 * `config` is the module's own fields, and nothing about them is shared or
 * imposed: two search modules are two different services with two different
 * settings, and the only field this file adds is the `module` discriminator that
 * names which of them an entry is configuring. That is what keeps the first
 * module from becoming the shape every later one has to pretend to fit.
 *
 * `create` receives what its own fields parsed to. The registry cannot express
 * that type — it holds modules of many shapes — so the module re-parses with the
 * runtime schema it built from the same `config` function and gets its types
 * back at its own boundary, where they are worth having.
 */
interface WebModule<TSlot extends WebSlot> {
  readonly config: (credential: CredentialSchema) => z.ZodRawShape;
  readonly create: (config: WebModuleConfig) => SlotCapabilities[TSlot];
  readonly id: string;
}

/**
 * The fields a module needs to talk to an HTTP service it is pointed at.
 *
 * Offered, never required. Most modules are a URL, a timeout and a token, and
 * repeating that in each of them would invite the three from drifting; a module
 * that is a hosted API with a fixed address and only a key declares just the key
 * instead, and nothing here says otherwise.
 */
function endpointFields<TCredential extends z.ZodType>(
  credential: TCredential,
  options: { readonly timeoutMs: number; readonly url: string },
): {
  apiKey: z.ZodOptional<TCredential>;
  timeoutMs: z.ZodDefault<z.ZodNumber>;
  url: z.ZodType<string>;
} {
  return {
    apiKey: credential
      .optional()
      .meta({ nox: { help: 'ui.credentialHelp', label: 'ui.credential', secret: true } }),
    timeoutMs: z
      .number()
      .int()
      .positive()
      .default(options.timeoutMs)
      .meta({ nox: { label: 'ui.timeout' } }),
    url: httpUrlSchema(options.url).meta({ nox: { label: 'ui.serviceUrl' } }),
  };
}

/**
 * The union an entry chooses from: every module of one slot, discriminated by
 * the ID it registered under. A slot with one module is still a union of one —
 * an entry names `"module": "searxng"` from the first day, so adding the second
 * module changes no file anybody had already written.
 */
function slotSchema(
  modules: readonly WebModule<WebSlot>[],
  credential: CredentialSchema,
): z.ZodType<SlotConfig> {
  const variants = modules.map((module) =>
    z.object({ ...module.config(credential), module: z.literal(module.id) }),
  );
  const [first, ...rest] = variants;
  if (first === undefined) {
    throw new Error('A web slot must have at least one module.');
  }

  // The union's own type is every module's fields at once, which is exactly what
  // this file must not know. What survives is what a slot is: the module named,
  // and the settings that module will re-parse for itself.
  return z.discriminatedUnion('module', [first, ...rest]);
}

export { endpointFields, runtimeCredentialSchema, slotSchema, storedCredentialSchema, WEB_SLOTS };

export type { CredentialSchema, SlotCapabilities, SlotConfig, WebModule, WebModuleConfig, WebSlot };
