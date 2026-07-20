/*
 * Application settings: the tool inventory, the web-tool services, and the
 * global gate policy.
 *
 * Two independent forms share this module because they are loaded together and
 * share the tool search box. They save separately, so each carries its own
 * saving/saved/error triple rather than a single form state.
 *
 * Credential handling is the part worth reading. The gateway never returns a
 * stored API key — only `hasApiKey` — so a saved capability must be sent back
 * without one to leave the credential untouched. `secretValues` therefore
 * holds only what the user typed this session, and `clearSecrets` is the
 * explicit opt-in to erase what is stored. An empty box means "leave it".
 */

import { atom, computed, map } from 'nanostores';

import { errorMessage, request } from '../utils/api';
import { NEW_RULE, parseRule, toEditableRule } from '../utils/gate-rules';
import { defaultsFor, setNested } from '../utils/schema-form';

import { loadTools, tools } from './catalog';

import type { EditableRule } from '../utils/gate-rules';
import type {
  CapabilityKind,
  GateConfig,
  GateMutation,
  ServiceDefinition,
  SettingsField,
  WebToolsConfig,
  WebToolsResponse,
} from '../utils/types';

type CapabilityDescriptor = {
  description: string;
  id: CapabilityKind;
  label: string;
};

type SettingsStatus = {
  error: string;
  loading: boolean;
};

/** Per-form state; `saved` drives the confirmation banner until the next edit. */
type FormStatus = {
  error: string;
  saved: boolean;
  saving: boolean;
};

const CAPABILITY_KINDS: CapabilityDescriptor[] = [
  {
    description: 'Search the web and return normalized links and snippets.',
    id: 'web_search',
    label: 'Web search',
  },
  {
    description: 'Extract one or more selected pages as Markdown.',
    id: 'web_extract',
    label: 'Web extract',
  },
];

const EMPTY_SERVICES: Record<CapabilityKind, ServiceDefinition[]> = { web_extract: [], web_search: [] };
const EMPTY_SECRETS: Record<CapabilityKind, string> = { web_extract: '', web_search: '' };
const EMPTY_CLEAR_FLAGS: Record<CapabilityKind, boolean> = { web_extract: false, web_search: false };

const IDLE_FORM: FormStatus = { error: '', saved: false, saving: false };

const rules = atom<EditableRule[]>([]);
const timeoutSeconds = atom<number>(120);
const webConfig = atom<WebToolsConfig>({});
const webServices = atom<Record<CapabilityKind, ServiceDefinition[]>>({ ...EMPTY_SERVICES });
/** Keys typed this session. Empty means the stored credential is untouched. */
const secretValues = atom<Record<CapabilityKind, string>>({ ...EMPTY_SECRETS });
const clearSecrets = atom<Record<CapabilityKind, boolean>>({ ...EMPTY_CLEAR_FLAGS });
const toolSearchQuery = atom<string>('');
const status = map<SettingsStatus>({ error: '', loading: true });
const gateForm = map<FormStatus>({ ...IDLE_FORM });
const webForm = map<FormStatus>({ ...IDLE_FORM });

const normalizedSearch = computed(toolSearchQuery, (query) => query.trim().toLowerCase());

const filteredToolSets = computed([tools, normalizedSearch], (all, query) =>
  all.filter((toolSet) => toolSet.toLowerCase().includes(query)));

/** Capabilities are searchable by their own text and by their service names. */
const filteredCapabilityKinds = computed([webServices, normalizedSearch], (services, query) =>
  CAPABILITY_KINDS.filter((capability) => {
    const serviceText = services[capability.id].map((service) => `${service.id} ${service.label}`).join(' ');
    return `${capability.id} ${capability.label} ${capability.description} ${serviceText}`
      .toLowerCase()
      .includes(query);
  }));

/* --------------------------------------------------------------- internals */

const GATE_PATH = '/api/v1/config/gate';
const WEB_TOOLS_PATH = '/api/v1/config/tools/web_tools';

const definitionFor = (kind: CapabilityKind): ServiceDefinition | undefined => {
  const service = webConfig.get()[kind]?.service;
  return webServices.get()[kind].find((definition) => definition.id === service);
};

/** Both forms clear their saved banner as soon as anything changes. */
const markGateDirty = (): void => gateForm.setKey('saved', false);
const markWebDirty = (): void => webForm.setKey('saved', false);

const adoptGate = (gate: GateConfig): void => {
  rules.set(gate.rules.map(toEditableRule));
  timeoutSeconds.set(gate.escalationTimeoutMs / 1000);
};

const adoptWebTools = (response: WebToolsResponse): void => {
  webConfig.set(response.config);
  webServices.set(response.services);
};

/* ----------------------------------------------------------------- actions */

const loadSettings = async (): Promise<void> => {
  status.setKey('loading', true);
  status.setKey('error', '');
  try {
    const [, gate, webTools] = await Promise.all([
      loadTools(),
      request<GateConfig>(GATE_PATH),
      request<WebToolsResponse>(WEB_TOOLS_PATH),
    ]);
    adoptGate(gate);
    adoptWebTools(webTools);
  } catch (error) {
    status.setKey('error', errorMessage(error, 'Settings could not be loaded.'));
  } finally {
    status.setKey('loading', false);
  }
};

/** The label of the service a capability currently uses. */
const serviceLabelFor = (kind: CapabilityKind): string => definitionFor(kind)?.label ?? 'Not configured';

/** Adopts the first available service, so an unconfigured capability can start. */
const initializeCapability = (kind: CapabilityKind): void => {
  const definition = webServices.get()[kind][0];
  if (!definition) return;
  webConfig.set({
    ...webConfig.get(),
    [kind]: {
      contract: defaultsFor(definition.contractFields),
      service: definition.id,
      serviceConfig: defaultsFor(definition.serviceFields),
    },
  });
  markWebDirty();
};

/**
 * Switches a capability to another service.
 *
 * The config is rebuilt from the new service's defaults rather than merged:
 * two services share no field names, so carrying values across would leave
 * settings that belong to neither. Any typed key is dropped for the same
 * reason — it authenticates against the service that is being replaced.
 */
const changeService = (kind: CapabilityKind, service: string): void => {
  const definition = webServices.get()[kind].find((candidate) => candidate.id === service);
  if (!definition) return;
  webConfig.set({
    ...webConfig.get(),
    [kind]: {
      contract: defaultsFor(definition.contractFields),
      service,
      serviceConfig: defaultsFor(definition.serviceFields),
    },
  });
  secretValues.set({ ...secretValues.get(), [kind]: '' });
  clearSecrets.set({ ...clearSecrets.get(), [kind]: false });
  markWebDirty();
};

const updateWebField = (
  kind: CapabilityKind,
  section: 'serviceConfig' | 'contract',
  field: SettingsField,
  value: unknown,
): void => {
  const capability = webConfig.get()[kind];
  if (!capability) return;
  setNested(capability[section], field.name, value);
  webConfig.set({ ...webConfig.get(), [kind]: { ...capability } });
  markWebDirty();
};

const setSecretValue = (kind: CapabilityKind, value: string): void => {
  secretValues.set({ ...secretValues.get(), [kind]: value });
  markWebDirty();
};

const setClearSecret = (kind: CapabilityKind, value: boolean): void => {
  clearSecrets.set({ ...clearSecrets.get(), [kind]: value });
  markWebDirty();
};

const setToolSearchQuery = (value: string): void => toolSearchQuery.set(value);

const saveWebTools = async (): Promise<void> => {
  webForm.set({ error: '', saved: false, saving: true });
  try {
    const payload = structuredClone(webConfig.get());
    for (const { id } of CAPABILITY_KINDS) {
      const capability = payload[id];
      if (!capability) continue;
      // `hasApiKey` is a read-only marker; sending it back would be rejected.
      delete capability.hasApiKey;
      if (secretValues.get()[id]) capability.serviceConfig.apiKey = secretValues.get()[id];
      else if (clearSecrets.get()[id]) capability.serviceConfig.apiKey = '';
    }

    adoptWebTools(await request<WebToolsResponse>(WEB_TOOLS_PATH, {
      body: JSON.stringify(payload),
      method: 'PUT',
    }));
    secretValues.set({ ...EMPTY_SECRETS });
    clearSecrets.set({ ...EMPTY_CLEAR_FLAGS });
    webForm.set({ error: '', saved: true, saving: false });
  } catch (error) {
    webForm.set({ error: errorMessage(error, 'Web tools could not be saved.'), saved: false, saving: false });
  }
};

const addRule = (): void => {
  rules.set([...rules.get(), { ...NEW_RULE }]);
  markGateDirty();
};

const removeRule = (index: number): void => {
  rules.set(rules.get().filter((_, ruleIndex) => ruleIndex !== index));
  markGateDirty();
};

const updateRule = <Key extends keyof EditableRule>(index: number, key: Key, value: EditableRule[Key]): void => {
  const current = rules.get()[index];
  if (!current) return;
  rules.set(rules.get().with(index, { ...current, [key]: value }));
  markGateDirty();
};

const setTimeoutSeconds = (value: number): void => {
  timeoutSeconds.set(value);
  markGateDirty();
};

const saveGate = async (): Promise<void> => {
  gateForm.set({ ...IDLE_FORM });

  const seconds = timeoutSeconds.get();
  if (!Number.isFinite(seconds) || seconds <= 0) {
    gateForm.setKey('error', 'Approval timeout must be greater than zero.');
    return;
  }

  let config: GateConfig;
  try {
    config = {
      escalationTimeoutMs: Math.round(seconds * 1000),
      rules: rules.get().map(parseRule),
    };
  } catch (error) {
    gateForm.setKey('error', errorMessage(error, 'The policy configuration is invalid.'));
    return;
  }

  gateForm.setKey('saving', true);
  try {
    const result = await request<GateMutation>(GATE_PATH, { body: JSON.stringify(config), method: 'PUT' });
    adoptGate(result.gate);
    gateForm.set({ error: '', saved: true, saving: false });
  } catch (error) {
    gateForm.set({ error: errorMessage(error, 'Tool policies could not be saved.'), saved: false, saving: false });
  }
};

export {
  CAPABILITY_KINDS,
  clearSecrets,
  filteredCapabilityKinds,
  filteredToolSets,
  gateForm,
  rules,
  secretValues,
  status,
  timeoutSeconds,
  toolSearchQuery,
  webConfig,
  webForm,
  webServices,
  addRule,
  changeService,
  initializeCapability,
  loadSettings,
  removeRule,
  saveGate,
  saveWebTools,
  serviceLabelFor,
  setClearSecret,
  setSecretValue,
  setTimeoutSeconds,
  setToolSearchQuery,
  updateRule,
  updateWebField,
};

export type {
  CapabilityDescriptor,
  FormStatus,
  SettingsStatus,
};
