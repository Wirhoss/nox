import { z } from 'zod';

import { type ConfigurableContribution, createContributionPoint } from './core.js';
import { type ChatProvider, providerBaseConfigSchema } from './providers.js';
import { identifierSchema, localeSchema } from './schemas.js';

import type { Broker } from './brokers.js';
import type { ToolSet } from './tools.js';

interface AuthorityContribution {
  readonly description: string;
}
const authorities = createContributionPoint<AuthorityContribution>('nox.authorities');

const messageKeySchema = z
  .string()
  .trim()
  .regex(
    /^[a-z][A-Za-z0-9_-]*(?:\.[a-z][A-Za-z0-9_-]*)*$/u,
    'Expected a dot-separated message key.',
  );
const messagesSchema = z.record(messageKeySchema, z.string());
const languagePackSchema = z.strictObject({
  default: z.boolean().optional(),
  direction: z.enum(['ltr', 'rtl']),
  locale: localeSchema,
  messages: messagesSchema,
  name: z.string().trim().min(1).max(100),
});
const translationFragmentSchema = z.strictObject({
  locale: localeSchema,
  messages: messagesSchema,
  namespace: identifierSchema,
});

type LanguagePackInput = z.input<typeof languagePackSchema>;
type TranslationFragmentInput = z.input<typeof translationFragmentSchema>;
type LanguagePack = Readonly<z.output<typeof languagePackSchema>>;
type TranslationFragment = Readonly<z.output<typeof translationFragmentSchema>>;

function freezeMessages(
  messages: Readonly<Record<string, string>>,
): Readonly<Record<string, string>> {
  return Object.freeze(Object.fromEntries(Object.entries(messages)));
}
function defineLanguagePack(input: LanguagePackInput): LanguagePack {
  const pack = languagePackSchema.parse(input);
  return Object.freeze({ ...pack, messages: freezeMessages(pack.messages) });
}
function defineTranslationFragment(input: TranslationFragmentInput): TranslationFragment {
  const fragment = translationFragmentSchema.parse(input);
  return Object.freeze({ ...fragment, messages: freezeMessages(fragment.messages) });
}
const languagePacks = createContributionPoint<LanguagePack>('nox.languages');
const translationFragments = createContributionPoint<TranslationFragment>('nox.translations');

const brokerSenderIdSchema = z.string().trim().min(1);

/**
 * Who a grant is written against, for one transport.
 *
 * Parameterised because the key is the transport's own vocabulary: a bare
 * sender ID everywhere, plus whatever that transport calls a group. A broker
 * that passes its own key schema gets an ID it cannot authenticate rejected at
 * load, beside the entry that named it, instead of silently becoming a grant
 * that never matches anyone.
 */
function brokerGrantsSchemaOf<TKey extends z.ZodType<string>>(
  key: TKey,
): z.ZodRecord<TKey, z.ZodReadonly<z.ZodArray<z.ZodString>>> {
  return z.record(key, z.array(z.string().trim().min(1)).readonly());
}

/**
 * One conversation's override.
 *
 * `grants` is optional rather than defaulted, and the difference is the whole
 * point: absent inherits the broker's grants, and `{}` is an explicit "nobody
 * here". Defaulting it to `{}` made an override that only redirects the agent
 * silently revoke every grant in that conversation — an answer nobody wrote.
 */
function brokerConversationOverrideSchemaOf<TKey extends z.ZodType<string>>(
  key: TKey,
): z.ZodObject<{
  agent: z.ZodOptional<z.ZodString>;
  grants: z.ZodOptional<z.ZodRecord<TKey, z.ZodReadonly<z.ZodArray<z.ZodString>>>>;
}> {
  return z.object({
    agent: z.string().min(1).optional(),
    grants: brokerGrantsSchemaOf(key).optional(),
  });
}

function brokerConversationsSchemaOf<TKey extends z.ZodType<string>>(
  key: TKey,
): z.ZodRecord<z.ZodString, ReturnType<typeof brokerConversationOverrideSchemaOf<TKey>>> {
  return z.record(z.string().trim().min(1), brokerConversationOverrideSchemaOf(key));
}

const brokerGrantsSchema = brokerGrantsSchemaOf(brokerSenderIdSchema);
const brokerConversationOverrideSchema = brokerConversationOverrideSchemaOf(brokerSenderIdSchema);
const brokerConversationsSchema = brokerConversationsSchemaOf(brokerSenderIdSchema);
const brokerBaseConfigSchema = z.strictObject({
  agent: z.string().min(1).optional(),
  conversations: brokerConversationsSchema.prefault({}),
  enabled: z.boolean().optional(),
  grants: brokerGrantsSchema.prefault({}),
});
const brokerConfigSchema = brokerBaseConfigSchema.extend({ type: z.string() });
type BrokerConfig = z.infer<typeof brokerConfigSchema>;
type BrokerConfigSchema = z.ZodObject<
  { type: z.ZodLiteral<string> } & typeof brokerBaseConfigSchema.shape
>;
interface BrokerHostPolicy {
  readonly authorization?: 'grants' | 'owner';
  /** False when the contribution is part of the control plane and may only be disabled. */
  readonly removable?: boolean;
  readonly selectableAgent?: boolean;
}
type BrokerContribution = ConfigurableContribution<BrokerConfigSchema, Broker> & {
  readonly host?: BrokerHostPolicy;
};
function brokerContribution<TSchema extends BrokerConfigSchema>(
  contribution: ConfigurableContribution<TSchema, Broker> & { readonly host?: BrokerHostPolicy },
): ConfigurableContribution<TSchema, Broker> & { readonly host?: BrokerHostPolicy } {
  return contribution;
}
const brokers = createContributionPoint<BrokerContribution>('nox.brokers');

// Provider configuration is defined beside the provider base class so adapters
// and the host validate from one schema object.
const providerConfigSchema = providerBaseConfigSchema.extend({ type: z.string() });
type ProviderConfig = z.infer<typeof providerConfigSchema>;
type ProviderConfigSchema = z.ZodObject<
  { type: z.ZodLiteral<string> } & typeof providerBaseConfigSchema.shape
>;
type ProviderContribution = ConfigurableContribution<ProviderConfigSchema, ChatProvider>;
function providerContribution<TSchema extends ProviderConfigSchema>(
  contribution: ConfigurableContribution<TSchema, ChatProvider>,
): ConfigurableContribution<TSchema, ChatProvider> {
  return contribution;
}
const providers = createContributionPoint<ProviderContribution>('nox.providers');

const toolSetBaseConfigSchema = z.object({
  enabledTools: z.array(z.string().min(1)).optional(),
});
const toolSetConfigSchema = toolSetBaseConfigSchema.extend({ type: z.string() });
type ToolSetConfig = z.infer<typeof toolSetConfigSchema>;
type ToolSetConfigSchema = z.ZodObject<
  { type: z.ZodLiteral<string> } & typeof toolSetBaseConfigSchema.shape
>;
type ToolSetContribution = ConfigurableContribution<ToolSetConfigSchema, ToolSet>;
function toolSetContribution<TSchema extends ToolSetConfigSchema>(
  contribution: ConfigurableContribution<TSchema, ToolSet>,
): ConfigurableContribution<TSchema, ToolSet> {
  return contribution;
}
const toolSets = createContributionPoint<ToolSetContribution>('nox.toolsets');

export {
  authorities,
  brokerBaseConfigSchema,
  brokerConfigSchema,
  brokerContribution,
  brokerConversationOverrideSchema,
  brokerConversationOverrideSchemaOf,
  brokerConversationsSchema,
  brokerConversationsSchemaOf,
  brokerGrantsSchema,
  brokerGrantsSchemaOf,
  brokers,
  brokerSenderIdSchema,
  defineLanguagePack,
  defineTranslationFragment,
  languagePacks,
  languagePackSchema,
  localeSchema,
  providerConfigSchema,
  providerContribution,
  providers,
  toolSetBaseConfigSchema,
  toolSetConfigSchema,
  toolSetContribution,
  toolSets,
  translationFragments,
  translationFragmentSchema,
};

export type {
  AuthorityContribution,
  BrokerConfig,
  BrokerConfigSchema,
  BrokerContribution,
  BrokerHostPolicy,
  LanguagePack,
  LanguagePackInput,
  ProviderConfig,
  ProviderConfigSchema,
  ProviderContribution,
  ToolSetConfig,
  ToolSetConfigSchema,
  ToolSetContribution,
  TranslationFragment,
  TranslationFragmentInput,
};
