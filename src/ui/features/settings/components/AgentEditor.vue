<script setup lang="ts">
import { computed, reactive, ref, watch } from 'vue'
import { onBeforeRouteLeave, onBeforeRouteUpdate } from 'vue-router'

import { useI18n } from '@/shared/i18n'
import { NoxButton } from '@/shared/ui/NoxButton'
import { NoxNotice } from '@/shared/ui/NoxNotice'
import { NoxTextField } from '@/shared/ui/NoxTextField'

import { modelCatalogProblem, modelOptions } from '../model/catalogs'
import { useSettingsStore } from '../stores/settings.store'
import CatalogField from './CatalogField.vue'

import type { ConfigSection, ConfigValue, ToolInventory } from '../api/settings.api'
import type { CatalogOption } from '../model/catalogs'
import type { SettingsSectionDefinition } from '../model/sections'

type EditorMode = 'form' | 'json'
type ToolChannel = 'direct' | 'routed'
type TaskName = 'compaction' | 'title'
type NumericInputKey =
  | 'compactAtRatio'
  | 'contextWindow'
  | 'frequencyPenalty'
  | 'maxTokens'
  | 'memoryMaxTokens'
  | 'presencePenalty'
  | 'reserveForOutput'
  | 'seed'
  | 'temperature'
  | 'topK'
  | 'topP'

type ToolGrant = string | { readonly id: string; readonly tools?: readonly string[] }

const MEMORY_TOOL_OPTIONS = [
  'memory_search',
  'memory_write',
  'memory_update',
  'memory_forget',
] as const

interface ToolSetOption {
  readonly available: boolean
  readonly description: string
  readonly extensionId?: string
  readonly name: string
  readonly toolSetId: string
  readonly tools: readonly ToolInventory[]
  readonly type: string
}

interface AgentDraft extends ConfigValue {
  context: ConfigValue
  description: string
  generation: ConfigValue
  maxIterations: 'unlimited' | number
  memory?: { id: string; maxTokens?: number; tools?: readonly string[] }
  model: string
  provider: string
  systemPrompt: string
  taskModels: ConfigValue
  toolSets: {
    direct: ToolGrant[]
    routed: ToolGrant[]
  }
}

interface Props {
  creating?: boolean
  definition: SettingsSectionDefinition
  entryId?: string
  memorySection?: ConfigSection
  providerSection?: ConfigSection
  section: ConfigSection
  toolSetSection?: ConfigSection
}

const props = withDefaults(defineProps<Props>(), {
  creating: false,
  entryId: undefined,
  memorySection: undefined,
  providerSection: undefined,
  toolSetSection: undefined,
})
const emit = defineEmits<{ created: [entryId: string]; deleted: [] }>()
const settings = useSettingsStore()
const { hasMessage, plural, t } = useI18n()
const mode = ref<EditorMode>('form')
const draft = ref<AgentDraft>(newAgentTemplate())
const jsonSource = ref('')
const originalSignature = ref('')
const entryIdInput = ref('')
const maxIterationsInput = ref('90')
const fieldErrors = ref<Readonly<Record<string, string>>>({})
const jsonError = ref<string>()
const confirmingDelete = ref(false)
const numericInputs = reactive<Record<NumericInputKey, string>>({
  compactAtRatio: '',
  contextWindow: '',
  frequencyPenalty: '',
  maxTokens: '',
  memoryMaxTokens: '',
  presencePenalty: '',
  reserveForOutput: '',
  seed: '',
  temperature: '',
  topK: '',
  topP: '',
})
const addingToolSet = reactive<Record<ToolChannel, boolean>>({ direct: false, routed: false })
const toolSetSearch = reactive<Record<ToolChannel, string>>({ direct: '', routed: '' })
const toolSearch = reactive<Record<string, string>>({})
const selectedValue = computed<ConfigValue>(() => {
  if (props.creating) return newAgentTemplate()
  if (props.entryId === undefined) return newAgentTemplate()
  const value = props.section.value[props.entryId]
  return isConfigValue(value) ? value : newAgentTemplate()
})
const title = computed(() =>
  props.creating
    ? t('settings.agent.titleNew')
    : (props.entryId ?? t('settings.agent.titleFallback')),
)
const sourceName = computed(() =>
  props.entryId === undefined ? props.section.name : `${props.section.name}/${props.entryId}.json`,
)
const providers = computed(() =>
  Object.entries(props.providerSection?.value ?? {}).map(([providerId, value]) => ({
    defaultModel: isConfigValue(value) ? stringValue(value.defaultModel) : '',
    models: isConfigValue(value) ? modelIds(value.modelConfigs) : [],
    providerId,
    type: isConfigValue(value) ? stringValue(value.type) : '',
  })),
)
const memories = computed(() =>
  Object.entries(props.memorySection?.value ?? {})
    .map(([configuredId, value]) => ({
      memoryId: configuredId,
      type: isConfigValue(value) ? stringValue(value.type) : '',
    }))
    .sort((left, right) => left.memoryId.localeCompare(right.memoryId)),
)
/**
 * The models the chosen provider serves, as its live instance reports them.
 *
 * Read from the runtime inventory rather than from `modelConfigs` in the
 * configured document: what an operator has declared so far is a subset of what
 * the endpoint actually offers, and the whole point of the list is to name a
 * model without having declared it first.
 */
const modelCatalog = computed(() => modelOptions(settings.providerInventory, draft.value.provider, t))
const modelCatalogProblemText = computed(() =>
  modelCatalogProblem(settings.providerInventory, draft.value.provider, t),
)

function taskModelCatalog(task: TaskName): readonly CatalogOption[] {
  return modelOptions(settings.providerInventory, taskProvider(task), t)
}

function taskModelProblem(task: TaskName): string | undefined {
  return modelCatalogProblem(settings.providerInventory, taskProvider(task), t)
}

/** A task without its own provider runs on the agent's, so its models are those. */
function taskProvider(task: TaskName): string {
  const own = taskValue(task, 'provider')
  return own.length > 0 ? own : draft.value.provider
}
const toolSets = computed<ToolSetOption[]>(() =>
  Object.entries(props.toolSetSection?.value ?? {})
    .map(([toolSetId, value]) => {
      const inventory = settings.toolSetInventory.find((candidate) => candidate.id === toolSetId)
      return {
        available: inventory?.available ?? false,
        description: contributionMessage(
          inventory?.extensionId,
          'toolSet.description',
          inventory?.description,
        ),
        extensionId: inventory?.extensionId,
        name: contributionMessage(inventory?.extensionId, 'toolSet.name', inventory?.name),
        toolSetId,
        tools:
          inventory?.tools.map((tool) => ({
            ...tool,
            description: contributionMessage(
              inventory.extensionId,
              `tools.${tool.name}.description`,
              tool.description,
            ),
          })) ?? [],
        type: inventory?.type ?? (isConfigValue(value) ? stringValue(value.type) : ''),
      }
    })
    .sort((a, b) => a.toolSetId.localeCompare(b.toolSetId)),
)
const hasGate = computed(() => isConfigValue(draft.value.gate))
const gateRules = computed(() => {
  const gate = configValue(draft.value.gate)
  return Array.isArray(gate.rules) ? gate.rules.length : 0
})
const dirty = computed(() => {
  if (mode.value === 'json') {
    const parsed = parseJson(false)
    return parsed === undefined
      ? jsonSource.value !== JSON.stringify(draft.value, undefined, 2)
      : JSON.stringify(parsed) !== JSON.stringify(selectedValue.value)
  }
  return formSignature() !== originalSignature.value
})

watch(
  [() => props.creating, () => props.entryId, selectedValue],
  () => {
    resetEditor()
  },
  { immediate: true },
)

function resetEditor(): void {
  draft.value = asAgentDraft(selectedValue.value)
  entryIdInput.value = ''
  fieldErrors.value = {}
  jsonError.value = undefined
  confirmingDelete.value = false
  addingToolSet.direct = false
  addingToolSet.routed = false
  toolSetSearch.direct = ''
  toolSetSearch.routed = ''
  for (const key of Object.keys(toolSearch)) toolSearch[key] = ''
  syncNumericInputs()
  jsonSource.value = JSON.stringify(draft.value, undefined, 2)
  originalSignature.value = formSignature()
}

function syncNumericInputs(): void {
  maxIterationsInput.value = String(draft.value.maxIterations)
  numericInputs.compactAtRatio = optionalNumber(draft.value.context.compactAtRatio)
  numericInputs.contextWindow = optionalNumber(draft.value.context.contextWindow)
  numericInputs.frequencyPenalty = optionalNumber(draft.value.generation.frequencyPenalty)
  numericInputs.maxTokens = optionalNumber(draft.value.generation.maxTokens)
  numericInputs.memoryMaxTokens = optionalNumber(configValue(draft.value.memory).maxTokens)
  numericInputs.presencePenalty = optionalNumber(draft.value.generation.presencePenalty)
  numericInputs.reserveForOutput = optionalNumber(draft.value.context.reserveForOutput)
  numericInputs.seed = optionalNumber(draft.value.generation.seed)
  numericInputs.temperature = optionalNumber(draft.value.generation.temperature)
  numericInputs.topK = optionalNumber(draft.value.generation.topK)
  numericInputs.topP = optionalNumber(draft.value.generation.topP)
}

function formSignature(): string {
  return JSON.stringify({
    draft: draft.value,
    entryId: entryIdInput.value,
    maxIterations: maxIterationsInput.value,
    numeric: numericInputs,
  })
}

function setString(
  field: 'description' | 'model' | 'provider' | 'systemPrompt',
  value: string,
): void {
  draft.value = { ...draft.value, [field]: value }
  clearFeedback(field)
}

function setEntryId(value: string): void {
  entryIdInput.value = value
  clearFeedback('entryId')
}

function setProvider(value: string): void {
  const provider = providers.value.find((candidate) => candidate.providerId === value)
  draft.value = {
    ...draft.value,
    model:
      draft.value.model.length === 0 && provider?.defaultModel !== undefined
        ? provider.defaultModel
        : draft.value.model,
    provider: value,
  }
  clearFeedback('provider')
}

function memoryId(): string {
  return stringValue(configValue(draft.value.memory).id)
}

function setMemory(value: string): void {
  if (value.length === 0) {
    draft.value = withoutProperty(draft.value, 'memory') as AgentDraft
    numericInputs.memoryMaxTokens = ''
  } else {
    const current = configValue(draft.value.memory)
    draft.value = {
      ...draft.value,
      memory: {
        id: value,
        maxTokens: typeof current.maxTokens === 'number' ? current.maxTokens : 2048,
        ...(Array.isArray(current.tools) && current.tools.length > 0
          ? { tools: current.tools }
          : {}),
      },
    }
    numericInputs.memoryMaxTokens = String(configValue(draft.value.memory).maxTokens)
  }
  clearFeedback('memory')
}

function setMemoryMaxTokens(value: string): void {
  numericInputs.memoryMaxTokens = value
  const current = configValue(draft.value.memory)
  if (value.trim().length === 0) {
    draft.value = { ...draft.value, memory: withoutProperty(current, 'maxTokens') } as AgentDraft
  } else {
    const parsed = Number(value)
    if (Number.isInteger(parsed) && parsed > 0) {
      draft.value = { ...draft.value, memory: { ...current, maxTokens: parsed } } as AgentDraft
    }
  }
  clearFeedback('memoryMaxTokens')
}

function grantedMemoryTools(): readonly string[] {
  const tools = configValue(draft.value.memory).tools
  return Array.isArray(tools) ? tools.filter((tool): tool is string => typeof tool === 'string') : []
}

function toggleMemoryTool(name: string, event: Event): void {
  const selected = new Set(grantedMemoryTools())
  if ((event.target as HTMLInputElement).checked) selected.add(name)
  else selected.delete(name)

  const current = configValue(draft.value.memory)
  const tools = MEMORY_TOOL_OPTIONS.filter((tool) => selected.has(tool))
  const memory =
    tools.length === 0 ? withoutProperty(current, 'tools') : { ...current, tools: [...tools] }
  draft.value = { ...draft.value, memory } as AgentDraft
  clearFeedback('memoryTools')
}

function setMaxIterations(value: string): void {
  maxIterationsInput.value = value
  if (value === 'unlimited') {
    draft.value = { ...draft.value, maxIterations: 'unlimited' }
  } else {
    const parsed = Number(value)
    if (Number.isInteger(parsed) && parsed > 0) {
      draft.value = { ...draft.value, maxIterations: parsed }
    }
  }
  clearFeedback('maxIterations')
}

function setOptionalNumber(
  target: 'context' | 'generation',
  property: string,
  input: NumericInputKey,
  value: string,
): void {
  numericInputs[input] = value
  const current = draft.value[target]
  if (value.trim().length === 0) {
    draft.value = { ...draft.value, [target]: withoutProperty(current, property) }
  } else {
    const parsed = Number(value)
    if (Number.isFinite(parsed)) {
      draft.value = { ...draft.value, [target]: { ...current, [property]: parsed } }
    }
  }
  clearFeedback(input)
}

function stopText(): string {
  const stop = draft.value.generation.stop
  return Array.isArray(stop)
    ? stop.filter((value): value is string => typeof value === 'string').join(', ')
    : ''
}

function setStop(value: string): void {
  const stop = value
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)
  draft.value = {
    ...draft.value,
    generation:
      stop.length === 0
        ? withoutProperty(draft.value.generation, 'stop')
        : { ...draft.value.generation, stop },
  }
  clearFeedback('stop')
}

function taskValue(task: TaskName, property: 'model' | 'provider'): string {
  const taskConfig = configValue(draft.value.taskModels[task])
  return stringValue(taskConfig[property])
}

function setTaskValue(task: TaskName, property: 'model' | 'provider', value: string): void {
  const current = configValue(draft.value.taskModels[task])
  const nextTask =
    value.length === 0 ? withoutProperty(current, property) : { ...current, [property]: value }
  const nextTasks =
    Object.keys(nextTask).length === 0
      ? withoutProperty(draft.value.taskModels, task)
      : { ...draft.value.taskModels, [task]: nextTask }
  draft.value = { ...draft.value, taskModels: nextTasks }
  clearFeedback(`${task}.${property}`)
}

function contributionMessage(extensionId: string | undefined, key: string, fallback = ''): string {
  if (extensionId === undefined) return fallback
  const messageKey = `${extensionId}.${key}`
  return hasMessage(messageKey) ? t(messageKey) : fallback
}

function channelLabel(channel: ToolChannel): string {
  return channel === 'direct' ? t('settings.agent.direct') : t('settings.agent.routed')
}

function otherChannel(channel: ToolChannel): ToolChannel {
  return channel === 'direct' ? 'routed' : 'direct'
}

function grantFor(channel: ToolChannel, toolSetId: string): ToolGrant | undefined {
  return draft.value.toolSets[channel].find((candidate) => grantId(candidate) === toolSetId)
}

function isToolSetGranted(channel: ToolChannel, toolSetId: string): boolean {
  return grantFor(channel, toolSetId) !== undefined
}

function isLimitedGrant(channel: ToolChannel, toolSetId: string): boolean {
  const grant = grantFor(channel, toolSetId)
  return typeof grant === 'object' && grant.tools !== undefined
}

function optionFor(toolSetId: string): ToolSetOption {
  return (
    toolSets.value.find((candidate) => candidate.toolSetId === toolSetId) ?? {
      available: false,
      description: '',
      name: '',
      toolSetId,
      tools: [],
      type: t('settings.agent.unknownContribution'),
    }
  )
}

function grantedToolSets(channel: ToolChannel): ToolSetOption[] {
  return draft.value.toolSets[channel].map((grant) => optionFor(grantId(grant)))
}

function addCandidates(channel: ToolChannel): ToolSetOption[] {
  const query = toolSetSearch[channel].trim().toLocaleLowerCase()
  return toolSets.value.filter((toolSet) => {
    if (isToolSetGranted(channel, toolSet.toolSetId)) return false
    if (query.length === 0) return true
    return [toolSet.toolSetId, toolSet.name, toolSet.type, toolSet.description].some((value) =>
      value.toLocaleLowerCase().includes(query),
    )
  })
}

function toggleToolSetPicker(channel: ToolChannel): void {
  addingToolSet[channel] = !addingToolSet[channel]
  if (!addingToolSet[channel]) toolSetSearch[channel] = ''
}

function addToolSet(channel: ToolChannel, toolSetId: string): void {
  const other = otherChannel(channel)
  const current = draft.value.toolSets[channel]
  const otherGrants = draft.value.toolSets[other]
  const preserved = otherGrants.find((grant) => grantId(grant) === toolSetId) ?? toolSetId
  draft.value = {
    ...draft.value,
    toolSets: {
      ...draft.value.toolSets,
      [channel]: [...current, preserved],
      [other]: otherGrants.filter((grant) => grantId(grant) !== toolSetId),
    },
  }
  addingToolSet[channel] = false
  toolSetSearch[channel] = ''
  clearFeedback(`toolSets.${channel}.${toolSetId}`)
}

function removeToolSet(channel: ToolChannel, toolSetId: string): void {
  draft.value = {
    ...draft.value,
    toolSets: {
      ...draft.value.toolSets,
      [channel]: draft.value.toolSets[channel].filter((grant) => grantId(grant) !== toolSetId),
    },
  }
  toolSearch[`${channel}:${toolSetId}`] = ''
  clearFeedback(`toolSets.${channel}.${toolSetId}`)
}

function grantTools(channel: ToolChannel, toolSetId: string): readonly string[] {
  const grant = grantFor(channel, toolSetId)
  return typeof grant === 'object' && grant.tools !== undefined ? grant.tools : []
}

function toolOptions(channel: ToolChannel, toolSetId: string): readonly ToolInventory[] {
  const byName = new Map(optionFor(toolSetId).tools.map((tool) => [tool.name, tool]))
  for (const name of grantTools(channel, toolSetId)) {
    if (!byName.has(name)) {
      byName.set(name, {
        authority: 'inventory.unavailable',
        description: t('settings.agent.preservedAllowlist'),
        name,
      })
    }
  }
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name))
}

function filteredTools(channel: ToolChannel, toolSetId: string): readonly ToolInventory[] {
  const query = (toolSearch[`${channel}:${toolSetId}`] ?? '').trim().toLocaleLowerCase()
  if (query.length === 0) return toolOptions(channel, toolSetId)
  return toolOptions(channel, toolSetId).filter((tool) =>
    [tool.name, tool.description, tool.authority].some((value) =>
      value.toLocaleLowerCase().includes(query),
    ),
  )
}

function replaceGrant(channel: ToolChannel, toolSetId: string, next: ToolGrant): void {
  draft.value = {
    ...draft.value,
    toolSets: {
      ...draft.value.toolSets,
      [channel]: draft.value.toolSets[channel].map((grant) =>
        grantId(grant) === toolSetId ? next : grant,
      ),
    },
  }
  clearFeedback(`toolSets.${channel}.${toolSetId}`)
}

function setGrantScope(channel: ToolChannel, toolSetId: string, limited: boolean): void {
  if (!limited) {
    replaceGrant(channel, toolSetId, toolSetId)
    return
  }
  const tools = toolOptions(channel, toolSetId).map((tool) => tool.name)
  if (tools.length === 0) return
  replaceGrant(channel, toolSetId, { id: toolSetId, tools })
}

function toggleGrantTool(
  channel: ToolChannel,
  toolSetId: string,
  toolName: string,
  event: Event,
): void {
  if (!(event.target instanceof HTMLInputElement)) return
  const current = grantTools(channel, toolSetId)
  const tools = event.target.checked
    ? [...new Set([...current, toolName])].sort((a, b) => a.localeCompare(b))
    : current.filter((candidate) => candidate !== toolName)
  replaceGrant(channel, toolSetId, { id: toolSetId, tools })
}

function toggleGate(event: Event): void {
  if (!(event.target instanceof HTMLInputElement)) return
  draft.value = event.target.checked
    ? { ...draft.value, gate: { defaultVerdict: 'escalate' } }
    : (withoutProperty(draft.value, 'gate') as AgentDraft)
  settings.clearMutation()
}

function gateString(property: string, fallback = ''): string {
  const value = stringValue(configValue(draft.value.gate)[property])
  return value.length > 0 ? value : fallback
}

function setGateString(property: string, value: string): void {
  const gate = configValue(draft.value.gate)
  draft.value = { ...draft.value, gate: { ...gate, [property]: value } }
  clearFeedback(`gate.${property}`)
}

function gateNumber(property: string, fallback: number): string {
  const value = configValue(draft.value.gate)[property]
  return typeof value === 'number' ? String(value) : String(fallback)
}

function setGateNumber(property: string, value: string): void {
  const parsed = Number(value)
  if (Number.isInteger(parsed) && parsed > 0) {
    const gate = configValue(draft.value.gate)
    draft.value = { ...draft.value, gate: { ...gate, [property]: parsed } }
  }
  clearFeedback(`gate.${property}`)
}

function gateHeuristicsEnabled(): boolean {
  const heuristics = configValue(configValue(draft.value.gate).heuristics)
  return heuristics.enabled !== false
}

function setGateHeuristics(event: Event): void {
  if (!(event.target instanceof HTMLInputElement)) return
  const gate = configValue(draft.value.gate)
  const heuristics = configValue(gate.heuristics)
  draft.value = {
    ...draft.value,
    gate: { ...gate, heuristics: { ...heuristics, enabled: event.target.checked } },
  }
  settings.clearMutation()
}

function switchMode(nextMode: EditorMode): void {
  if (mode.value === nextMode) return
  if (nextMode === 'json') {
    jsonSource.value = JSON.stringify(draft.value, undefined, 2)
    jsonError.value = undefined
    mode.value = nextMode
    return
  }

  const parsed = parseJson(true)
  if (parsed === undefined) return
  draft.value = asAgentDraft(parsed)
  syncNumericInputs()
  mode.value = nextMode
}

function formatJson(): void {
  const parsed = parseJson(true)
  if (parsed !== undefined) jsonSource.value = JSON.stringify(parsed, undefined, 2)
}

async function save(): Promise<void> {
  fieldErrors.value = {}
  jsonError.value = undefined
  let value: ConfigValue

  if (mode.value === 'json') {
    const parsed = parseJson(true)
    if (parsed === undefined) return
    value = parsed
  } else {
    if (!validateForm()) return
    value = cloneValue(draft.value)
  }

  let saved: boolean
  if (props.creating) {
    const nextEntryId = entryIdInput.value.trim()
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(nextEntryId)) {
      fieldErrors.value = {
        ...fieldErrors.value,
        entryId: t('settings.validation.entryId'),
      }
      return
    }
    saved = await settings.createEntry(props.section.key, nextEntryId, value)
    if (saved) emit('created', nextEntryId)
  } else if (props.entryId !== undefined) {
    saved = await settings.saveEntry(props.section.key, props.entryId, value)
  } else {
    return
  }

  if (saved) originalSignature.value = formSignature()
}

async function remove(): Promise<void> {
  if (props.entryId === undefined) return
  if (await settings.deleteEntry(props.section.key, props.entryId)) emit('deleted')
}

function validateForm(): boolean {
  const errors: Record<string, string> = {}
  if (draft.value.provider.trim().length === 0)
    errors.provider = t('settings.agent.validation.provider')
  if (draft.value.model.trim().length === 0) errors.model = t('settings.agent.validation.model')
  if (draft.value.systemPrompt.trim().length === 0) {
    errors.systemPrompt = t('settings.agent.validation.systemPrompt')
  }

  if (
    maxIterationsInput.value !== 'unlimited' &&
    (!Number.isInteger(Number(maxIterationsInput.value)) || Number(maxIterationsInput.value) <= 0)
  ) {
    errors.maxIterations = t('settings.agent.validation.maxIterations')
  }

  validateOptionalNumber(errors, 'temperature', 0, 1)
  validateOptionalNumber(errors, 'topP', 0, 1)
  validateOptionalNumber(errors, 'topK', 1, undefined, true)
  validateOptionalNumber(errors, 'maxTokens', 1, undefined, true)
  validateOptionalNumber(errors, 'memoryMaxTokens', 1, 16_384, true)
  validateOptionalNumber(errors, 'seed', undefined, undefined, true)
  validateOptionalNumber(errors, 'frequencyPenalty', -2, 2)
  validateOptionalNumber(errors, 'presencePenalty', -2, 2)
  validateOptionalNumber(errors, 'contextWindow', 1, undefined, true)
  validateOptionalNumber(errors, 'reserveForOutput', 0, undefined, true)
  validateOptionalNumber(errors, 'compactAtRatio', Number.MIN_VALUE, 1)

  if (
    numericInputs.contextWindow.length === 0 &&
    (numericInputs.reserveForOutput.length > 0 || numericInputs.compactAtRatio.length > 0)
  ) {
    errors.contextWindow = t('settings.agent.validation.contextWindowRequired')
  }
  if (
    numericInputs.contextWindow.length > 0 &&
    numericInputs.reserveForOutput.length > 0 &&
    Number(numericInputs.reserveForOutput) >= Number(numericInputs.contextWindow)
  ) {
    errors.reserveForOutput = t('settings.agent.validation.reserveSmaller')
  }

  for (const task of ['compaction', 'title'] as const) {
    if (taskValue(task, 'provider').length > 0 && taskValue(task, 'model').length === 0) {
      errors[`${task}.model`] = t('settings.agent.validation.overrideModel')
    }
  }

  for (const channel of ['direct', 'routed'] as const) {
    for (const grant of draft.value.toolSets[channel]) {
      if (typeof grant === 'object' && grant.tools?.length === 0) {
        errors[`toolSets.${channel}.${grant.id}`] = t('settings.agent.validation.toolSelection')
      }
    }
  }

  fieldErrors.value = errors
  return Object.keys(errors).length === 0
}

function validateOptionalNumber(
  errors: Record<string, string>,
  key: NumericInputKey,
  minimum?: number,
  maximum?: number,
  integer = false,
): void {
  const input = numericInputs[key].trim()
  if (input.length === 0) return
  const value = Number(input)
  if (
    !Number.isFinite(value) ||
    (integer && !Number.isInteger(value)) ||
    (minimum !== undefined && value < minimum) ||
    (maximum !== undefined && value > maximum)
  ) {
    if (minimum !== undefined && maximum !== undefined) {
      errors[key] = integer
        ? t('settings.validation.integerRange', { maximum, minimum })
        : t('settings.validation.numberRange', { maximum, minimum })
    } else if (minimum !== undefined) {
      errors[key] = integer
        ? t('settings.validation.integerMinimum', { minimum })
        : t('settings.validation.numberMinimum', { minimum })
    } else {
      errors[key] = integer ? t('settings.validation.integer') : t('settings.validation.number')
    }
  }
}

function parseJson(report: boolean): ConfigValue | undefined {
  try {
    const parsed: unknown = JSON.parse(jsonSource.value)
    if (!isConfigValue(parsed)) {
      if (report) jsonError.value = t('settings.agent.validation.configurationObject')
      return undefined
    }
    if (report) jsonError.value = undefined
    return parsed
  } catch {
    if (report) jsonError.value = t('settings.validation.invalidJson')
    return undefined
  }
}

function clearFeedback(field?: string): void {
  if (field !== undefined && field in fieldErrors.value) {
    fieldErrors.value = withoutProperty(fieldErrors.value, field) as Readonly<
      Record<string, string>
    >
  }
  settings.clearMutation()
}

function canLeave(): boolean {
  return !dirty.value || window.confirm(t('settings.confirm.discardAgent'))
}

onBeforeRouteLeave(canLeave)
onBeforeRouteUpdate(canLeave)

function asAgentDraft(value: ConfigValue): AgentDraft {
  const cloned = cloneValue(value)
  const toolSetsValue = configValue(cloned.toolSets)
  const maxIterations = cloned.maxIterations
  return {
    ...cloned,
    context: configValue(cloned.context),
    description: stringValue(cloned.description),
    generation: configValue(cloned.generation),
    maxIterations:
      maxIterations === 'unlimited' || (typeof maxIterations === 'number' && maxIterations > 0)
        ? maxIterations
        : 90,
    model: stringValue(cloned.model),
    provider: stringValue(cloned.provider),
    systemPrompt: stringValue(cloned.systemPrompt),
    taskModels: configValue(cloned.taskModels),
    toolSets: {
      direct: toolGrants(toolSetsValue.direct),
      routed: toolGrants(toolSetsValue.routed),
    },
  }
}

function newAgentTemplate(): AgentDraft {
  return {
    context: {},
    description: '',
    generation: {},
    maxIterations: 90,
    model: '',
    provider: '',
    systemPrompt: '',
    taskModels: {},
    toolSets: { direct: [], routed: [] },
  }
}

function modelIds(value: unknown): readonly string[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((candidate) => {
    if (!isConfigValue(candidate)) return []
    const kind = stringValue(candidate.kind)
    // Kindless declarations predate explicit capabilities and are chat by contract.
    if (kind.length > 0 && kind !== 'chat') return []
    const modelId = stringValue(candidate.modelId)
    return modelId.length > 0 ? [modelId] : []
  })
}

function toolGrants(value: unknown): ToolGrant[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((candidate): ToolGrant[] => {
    if (typeof candidate === 'string' && candidate.length > 0) return [candidate]
    if (!isConfigValue(candidate)) return []
    const id = stringValue(candidate.id)
    if (id.length === 0) return []
    const tools = Array.isArray(candidate.tools)
      ? candidate.tools.filter((tool): tool is string => typeof tool === 'string')
      : undefined
    return [{ id, ...(tools === undefined ? {} : { tools }) }]
  })
}

function grantId(grant: ToolGrant): string {
  return typeof grant === 'string' ? grant : grant.id
}

function configValue(value: unknown): ConfigValue {
  return isConfigValue(value) ? value : {}
}

function isConfigValue(value: unknown): value is ConfigValue {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function optionalNumber(value: unknown): string {
  return typeof value === 'number' ? String(value) : ''
}

function cloneValue<T extends ConfigValue>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function withoutProperty(value: ConfigValue, property: string): ConfigValue {
  return Object.fromEntries(Object.entries(value).filter(([key]) => key !== property))
}
</script>

<template>
  <article class="agent-editor">
    <header class="agent-editor__header">
      <div>
        <p>
          {{ t('settings.agent.header') }} //
          {{ props.entryId?.toUpperCase() ?? t('common.new').toUpperCase() }}
        </p>
        <h2>{{ title }}</h2>
        <span>{{ t(props.definition.description) }}</span>
      </div>
      <div class="agent-editor__header-side">
        <div class="agent-editor__badges">
          <span>{{ sourceName }}</span>
          <span>{{ t('settings.editor.hotApply') }}</span>
        </div>
        <div class="agent-editor__modes" :aria-label="t('settings.editor.mode')">
          <button :aria-pressed="mode === 'form'" type="button" @click="switchMode('form')">
            {{ t('settings.editor.form') }}
          </button>
          <button :aria-pressed="mode === 'json'" type="button" @click="switchMode('json')">
            {{ t('settings.editor.json') }}
          </button>
        </div>
      </div>
    </header>

    <div class="agent-editor__content">
      <NoxNotice
        v-if="settings.mutation.type === 'saved'"
        :title="t('settings.agent.saved')"
        :tone="settings.mutation.restartRequired ? 'warning' : 'info'"
      >
        <p>
          {{
            t(
              settings.mutation.restartRequired
                ? 'settings.editor.savedRestart'
                : 'settings.editor.savedImmediate',
            )
          }}
        </p>
      </NoxNotice>

      <NoxNotice
        v-else-if="settings.mutation.type === 'failed'"
        :title="t('settings.agent.changeRefused')"
        tone="danger"
      >
        <p>{{ settings.mutation.message }}</p>
      </NoxNotice>

      <NoxTextField
        v-if="props.creating"
        id="agent-entry-id"
        :model-value="entryIdInput"
        :error="fieldErrors.entryId"
        :hint="t('settings.agent.idHint')"
        :label="t('settings.agent.id')"
        placeholder="researcher"
        required
        @update:model-value="setEntryId($event)"
      />

      <template v-if="mode === 'form'">
        <section class="agent-editor__section" aria-labelledby="agent-identity-title">
          <div class="agent-editor__section-copy">
            <p>01 // {{ t('settings.agent.identity') }}</p>
            <h3 id="agent-identity-title">{{ t('settings.agent.identityModel') }}</h3>
            <span>{{ t('settings.agent.identityModelHelp') }}</span>
          </div>
          <div class="agent-editor__fields">
            <NoxTextField
              id="agent-description"
              :model-value="draft.description"
              :hint="t('settings.agent.descriptionHint')"
              :label="t('settings.agent.description')"
              :placeholder="t('settings.agent.descriptionPlaceholder')"
              @update:model-value="setString('description', $event)"
            />
            <div class="agent-editor__field-grid">
              <div
                class="agent-editor__field"
                :class="{ 'agent-editor__field--invalid': fieldErrors.provider }"
              >
                <label for="agent-provider"
                  >{{ t('settings.agent.provider') }}
                  <small>{{ t('common.requiredShort') }}</small></label
                >
                <select
                  id="agent-provider"
                  :value="draft.provider"
                  :aria-invalid="fieldErrors.provider !== undefined"
                  @change="setProvider(($event.target as HTMLSelectElement).value)"
                >
                  <option value="">{{ t('settings.agent.selectProvider') }}</option>
                  <option
                    v-for="provider in providers"
                    :key="provider.providerId"
                    :value="provider.providerId"
                  >
                    {{ provider.providerId }} · {{ provider.type }}
                  </option>
                </select>
                <p v-if="fieldErrors.provider" class="agent-editor__error">
                  {{ fieldErrors.provider }}
                </p>
              </div>
              <CatalogField
                id="agent-model"
                :model-value="draft.model"
                :error="fieldErrors.model"
                :hint="t('settings.agent.modelHint')"
                :label="t('settings.agent.model')"
                :options="modelCatalog"
                :problem="modelCatalogProblemText"
                required
                @update:model-value="setString('model', $event)"
              />
            </div>
            <NoxTextField
              id="agent-max-iterations"
              :model-value="maxIterationsInput"
              :error="fieldErrors.maxIterations"
              :hint="t('settings.agent.maxIterationsHint')"
              :label="t('settings.agent.maxIterations')"
              required
              @update:model-value="setMaxIterations($event)"
            />
            <div class="agent-editor__field-grid">
              <div class="agent-editor__field">
                <label for="agent-memory">{{ t('settings.agent.memory') }}</label>
                <select
                  id="agent-memory"
                  :value="memoryId()"
                  @change="setMemory(($event.target as HTMLSelectElement).value)"
                >
                  <option value="">{{ t('settings.agent.memoryDisabled') }}</option>
                  <option
                    v-if="memoryId().length > 0 && !memories.some((memory) => memory.memoryId === memoryId())"
                    :value="memoryId()"
                  >
                    {{ memoryId() }} · {{ t('settings.agent.unknownContribution') }}
                  </option>
                  <option
                    v-for="memory in memories"
                    :key="memory.memoryId"
                    :value="memory.memoryId"
                  >
                    {{ memory.memoryId }} · {{ memory.type }}
                  </option>
                </select>
                <p class="agent-editor__hint">{{ t('settings.agent.memoryHint') }}</p>
              </div>
              <NoxTextField
                v-if="memoryId().length > 0"
                id="agent-memory-max-tokens"
                :model-value="numericInputs.memoryMaxTokens"
                :error="fieldErrors.memoryMaxTokens"
                :hint="t('settings.agent.memoryMaxTokensHint')"
                :label="t('settings.agent.memoryMaxTokens')"
                required
                @update:model-value="setMemoryMaxTokens($event)"
              />
              <div
                v-if="memoryId().length > 0"
                class="agent-editor__field agent-editor__memory-tools"
              >
                <label>{{ t('settings.agent.memoryTools') }}</label>
                <p class="agent-editor__hint">{{ t('settings.agent.memoryToolsHint') }}</p>
                <div class="agent-editor__tool-allowlist" role="group">
                  <label v-for="tool in MEMORY_TOOL_OPTIONS" :key="tool">
                    <input
                      type="checkbox"
                      :checked="grantedMemoryTools().includes(tool)"
                      @change="toggleMemoryTool(tool, $event)"
                    />
                    <span>
                      <strong>{{ tool }}</strong>
                      <small>{{ t(`settings.agent.memoryTool.${tool}`) }}</small>
                    </span>
                  </label>
                </div>
              </div>
            </div>
          </div>
        </section>

        <section class="agent-editor__section" aria-labelledby="agent-directive-title">
          <div class="agent-editor__section-copy">
            <p>02 // {{ t('settings.agent.directive') }}</p>
            <h3 id="agent-directive-title">{{ t('settings.agent.systemPrompt') }}</h3>
            <span>{{ t('settings.agent.systemPromptHelp') }}</span>
          </div>
          <div
            class="agent-editor__field"
            :class="{ 'agent-editor__field--invalid': fieldErrors.systemPrompt }"
          >
            <label for="agent-system-prompt"
              >{{ t('settings.agent.systemPrompt') }}
              <small>{{ t('common.requiredShort') }}</small></label
            >
            <textarea
              id="agent-system-prompt"
              :value="draft.systemPrompt"
              :aria-invalid="fieldErrors.systemPrompt !== undefined"
              :placeholder="t('settings.agent.systemPromptPlaceholder')"
              @input="setString('systemPrompt', ($event.target as HTMLTextAreaElement).value)"
            ></textarea>
            <p v-if="fieldErrors.systemPrompt" class="agent-editor__error">
              {{ fieldErrors.systemPrompt }}
            </p>
          </div>
        </section>

        <section class="agent-editor__section" aria-labelledby="agent-tools-title">
          <div class="agent-editor__section-copy">
            <p>03 // {{ t('settings.agent.capabilities') }}</p>
            <h3 id="agent-tools-title">{{ t('settings.agent.toolSetGrants') }}</h3>
            <span>{{ t('settings.agent.toolSetGrantsHelp') }}</span>
          </div>
          <div
            v-if="
              toolSets.length > 0 ||
              draft.toolSets.direct.length > 0 ||
              draft.toolSets.routed.length > 0
            "
            class="agent-editor__grant-lists"
          >
            <section
              v-for="channel in ['direct', 'routed'] as const"
              :key="channel"
              class="agent-editor__grant-list"
              :aria-labelledby="`agent-${channel}-tools-title`"
            >
              <header>
                <div>
                  <span>{{
                    channel === 'direct'
                      ? t('settings.agent.modelContext')
                      : t('settings.agent.onDemandRouter')
                  }}</span>
                  <h4 :id="`agent-${channel}-tools-title`">{{ channelLabel(channel) }}</h4>
                  <small>{{
                    t('settings.agent.grantedCount', { count: draft.toolSets[channel].length })
                  }}</small>
                </div>
                <button
                  type="button"
                  :aria-expanded="addingToolSet[channel]"
                  @click="toggleToolSetPicker(channel)"
                >
                  {{ addingToolSet[channel] ? t('common.close') : `+ ${t('common.add')}` }}
                </button>
              </header>

              <div v-if="addingToolSet[channel]" class="agent-editor__toolset-picker">
                <label :for="`agent-${channel}-toolset-search`">
                  {{ t('settings.agent.searchToolSets') }}
                </label>
                <input
                  :id="`agent-${channel}-toolset-search`"
                  :value="toolSetSearch[channel]"
                  type="search"
                  :placeholder="t('settings.agent.searchToolSetsPlaceholder')"
                  @input="toolSetSearch[channel] = ($event.target as HTMLInputElement).value"
                />
                <div v-if="addCandidates(channel).length > 0">
                  <button
                    v-for="candidate in addCandidates(channel)"
                    :key="candidate.toolSetId"
                    type="button"
                    @click="addToolSet(channel, candidate.toolSetId)"
                  >
                    <span>
                      <strong>{{ candidate.toolSetId }}</strong>
                      <small>{{ candidate.name || candidate.type }}</small>
                    </span>
                    <span>
                      {{
                        isToolSetGranted(otherChannel(channel), candidate.toolSetId)
                          ? t('settings.agent.moveFrom', {
                              channel: channelLabel(otherChannel(channel)),
                            })
                          : t('common.add').toUpperCase()
                      }}
                      →
                    </span>
                  </button>
                </div>
                <p v-else>{{ t('settings.agent.noMatchingToolSets') }}</p>
              </div>

              <div v-if="grantedToolSets(channel).length > 0" class="agent-editor__grants">
                <article
                  v-for="toolSet in grantedToolSets(channel)"
                  :key="toolSet.toolSetId"
                  class="agent-editor__grant"
                >
                  <header>
                    <div>
                      <strong>{{ toolSet.toolSetId }}</strong>
                      <span>{{ toolSet.name || toolSet.type }}</span>
                    </div>
                    <button
                      type="button"
                      :aria-label="
                        t('settings.agent.removeToolSet', {
                          channel: channelLabel(channel),
                          toolSet: toolSet.toolSetId,
                        })
                      "
                      @click="removeToolSet(channel, toolSet.toolSetId)"
                    >
                      {{ t('common.remove') }}
                    </button>
                  </header>

                  <p v-if="toolSet.description">{{ toolSet.description }}</p>
                  <p v-else-if="!toolSet.available" class="agent-editor__inventory-warning">
                    {{ t('settings.agent.inventoryUnavailable') }}
                  </p>

                  <div
                    class="agent-editor__grant-scope"
                    :aria-label="
                      t('settings.agent.grantScope', {
                        channel: channelLabel(channel),
                        toolSet: toolSet.toolSetId,
                      })
                    "
                    role="group"
                  >
                    <button
                      type="button"
                      :aria-pressed="!isLimitedGrant(channel, toolSet.toolSetId)"
                      @click="setGrantScope(channel, toolSet.toolSetId, false)"
                    >
                      {{ t('settings.agent.allTools') }}
                    </button>
                    <button
                      type="button"
                      :aria-pressed="isLimitedGrant(channel, toolSet.toolSetId)"
                      :disabled="toolOptions(channel, toolSet.toolSetId).length === 0"
                      @click="setGrantScope(channel, toolSet.toolSetId, true)"
                    >
                      {{ t('settings.agent.selectedTools') }}
                      <small v-if="isLimitedGrant(channel, toolSet.toolSetId)">
                        {{ grantTools(channel, toolSet.toolSetId).length }}
                      </small>
                    </button>
                  </div>

                  <div
                    v-if="isLimitedGrant(channel, toolSet.toolSetId)"
                    class="agent-editor__tool-allowlist"
                  >
                    <input
                      :value="toolSearch[`${channel}:${toolSet.toolSetId}`] ?? ''"
                      type="search"
                      :aria-label="
                        t('settings.agent.searchToolsIn', {
                          channel: channelLabel(channel),
                          toolSet: toolSet.toolSetId,
                        })
                      "
                      :placeholder="t('settings.agent.searchTools')"
                      @input="
                        toolSearch[`${channel}:${toolSet.toolSetId}`] = (
                          $event.target as HTMLInputElement
                        ).value
                      "
                    />
                    <div v-if="filteredTools(channel, toolSet.toolSetId).length > 0">
                      <label
                        v-for="tool in filteredTools(channel, toolSet.toolSetId)"
                        :key="tool.name"
                      >
                        <input
                          type="checkbox"
                          :checked="grantTools(channel, toolSet.toolSetId).includes(tool.name)"
                          @change="toggleGrantTool(channel, toolSet.toolSetId, tool.name, $event)"
                        />
                        <span>
                          <strong>{{ tool.name }}</strong>
                          <small>{{ tool.description }}</small>
                        </span>
                      </label>
                    </div>
                    <p v-else>{{ t('settings.agent.noToolsMatch') }}</p>
                  </div>

                  <p
                    v-if="fieldErrors[`toolSets.${channel}.${toolSet.toolSetId}`]"
                    class="agent-editor__error"
                  >
                    {{ fieldErrors[`toolSets.${channel}.${toolSet.toolSetId}`] }}
                  </p>
                </article>
              </div>
              <p v-else class="agent-editor__grant-empty">
                {{ t(`settings.agent.noChannelCapabilities.${channel}`) }}
              </p>
            </section>
          </div>
          <p v-else class="agent-editor__empty">
            {{ t('settings.agent.noToolSetsConfigured') }}
          </p>
        </section>

        <section class="agent-editor__section" aria-labelledby="agent-tasks-title">
          <div class="agent-editor__section-copy">
            <p>04 // {{ t('settings.agent.internalTasks') }}</p>
            <h3 id="agent-tasks-title">{{ t('settings.agent.taskOverrides') }}</h3>
            <span>{{ t('settings.agent.taskOverridesHelp') }}</span>
          </div>
          <div class="agent-editor__tasks">
            <fieldset v-for="task in ['compaction', 'title'] as const" :key="task">
              <legend>{{ t(`settings.agent.task.${task}`) }}</legend>
              <div class="agent-editor__field-grid">
                <div class="agent-editor__field">
                  <label :for="`agent-${task}-provider`">{{
                    t('settings.agent.providerOverride')
                  }}</label>
                  <select
                    :id="`agent-${task}-provider`"
                    :value="taskValue(task, 'provider')"
                    @change="
                      setTaskValue(task, 'provider', ($event.target as HTMLSelectElement).value)
                    "
                  >
                    <option value="">{{ t('settings.agent.useAgentProvider') }}</option>
                    <option
                      v-for="provider in providers"
                      :key="provider.providerId"
                      :value="provider.providerId"
                    >
                      {{ provider.providerId }}
                    </option>
                  </select>
                </div>
                <CatalogField
                  :id="`agent-${task}-model`"
                  :model-value="taskValue(task, 'model')"
                  :error="fieldErrors[`${task}.model`]"
                  :hint="t('settings.agent.useAgentModel')"
                  :label="t('settings.agent.modelOverride')"
                  :options="taskModelCatalog(task)"
                  :problem="taskModelProblem(task)"
                  @update:model-value="setTaskValue(task, 'model', $event)"
                />
              </div>
            </fieldset>
          </div>
        </section>

        <details class="agent-editor__advanced-group">
          <summary>
            <span>05 // {{ t('settings.agent.runtimeTuning') }}</span>
            <strong>{{ t('settings.agent.generationContext') }}</strong>
            <small>{{ t('settings.agent.generationContextHelp') }}</small>
          </summary>
          <div class="agent-editor__advanced-content">
            <fieldset>
              <legend>{{ t('settings.agent.generation') }}</legend>
              <div class="agent-editor__numeric-grid">
                <NoxTextField
                  id="agent-temperature"
                  :model-value="numericInputs.temperature"
                  :error="fieldErrors.temperature"
                  hint="0–1"
                  :label="t('settings.agent.temperature')"
                  @update:model-value="
                    setOptionalNumber('generation', 'temperature', 'temperature', $event)
                  "
                />
                <NoxTextField
                  id="agent-top-p"
                  :model-value="numericInputs.topP"
                  :error="fieldErrors.topP"
                  hint="0–1"
                  :label="t('settings.agent.topP')"
                  @update:model-value="setOptionalNumber('generation', 'topP', 'topP', $event)"
                />
                <NoxTextField
                  id="agent-top-k"
                  :model-value="numericInputs.topK"
                  :error="fieldErrors.topK"
                  :label="t('settings.agent.topK')"
                  @update:model-value="setOptionalNumber('generation', 'topK', 'topK', $event)"
                />
                <NoxTextField
                  id="agent-max-tokens"
                  :model-value="numericInputs.maxTokens"
                  :error="fieldErrors.maxTokens"
                  :label="t('settings.agent.maxTokens')"
                  @update:model-value="
                    setOptionalNumber('generation', 'maxTokens', 'maxTokens', $event)
                  "
                />
                <NoxTextField
                  id="agent-frequency-penalty"
                  :model-value="numericInputs.frequencyPenalty"
                  :error="fieldErrors.frequencyPenalty"
                  hint="−2–2"
                  :label="t('settings.agent.frequencyPenalty')"
                  @update:model-value="
                    setOptionalNumber('generation', 'frequencyPenalty', 'frequencyPenalty', $event)
                  "
                />
                <NoxTextField
                  id="agent-presence-penalty"
                  :model-value="numericInputs.presencePenalty"
                  :error="fieldErrors.presencePenalty"
                  hint="−2–2"
                  :label="t('settings.agent.presencePenalty')"
                  @update:model-value="
                    setOptionalNumber('generation', 'presencePenalty', 'presencePenalty', $event)
                  "
                />
                <NoxTextField
                  id="agent-seed"
                  :model-value="numericInputs.seed"
                  :error="fieldErrors.seed"
                  :label="t('settings.agent.seed')"
                  @update:model-value="setOptionalNumber('generation', 'seed', 'seed', $event)"
                />
                <NoxTextField
                  id="agent-stop"
                  :model-value="stopText()"
                  :hint="t('settings.agent.stopHint')"
                  :label="t('settings.agent.stop')"
                  @update:model-value="setStop($event)"
                />
              </div>
            </fieldset>
            <fieldset>
              <legend>{{ t('settings.agent.contextPressure') }}</legend>
              <div class="agent-editor__numeric-grid">
                <NoxTextField
                  id="agent-context-window"
                  :model-value="numericInputs.contextWindow"
                  :error="fieldErrors.contextWindow"
                  :label="t('settings.agent.contextWindow')"
                  @update:model-value="
                    setOptionalNumber('context', 'contextWindow', 'contextWindow', $event)
                  "
                />
                <NoxTextField
                  id="agent-reserve-output"
                  :model-value="numericInputs.reserveForOutput"
                  :error="fieldErrors.reserveForOutput"
                  :label="t('settings.agent.reserveOutput')"
                  @update:model-value="
                    setOptionalNumber('context', 'reserveForOutput', 'reserveForOutput', $event)
                  "
                />
                <NoxTextField
                  id="agent-compact-ratio"
                  :model-value="numericInputs.compactAtRatio"
                  :error="fieldErrors.compactAtRatio"
                  hint="0–1"
                  :label="t('settings.agent.compactRatio')"
                  @update:model-value="
                    setOptionalNumber('context', 'compactAtRatio', 'compactAtRatio', $event)
                  "
                />
              </div>
            </fieldset>
          </div>
        </details>

        <section class="agent-editor__section" aria-labelledby="agent-gate-title">
          <div class="agent-editor__section-copy">
            <p>06 // {{ t('settings.agent.permissionGate') }}</p>
            <h3 id="agent-gate-title">{{ t('settings.agent.actionPolicy') }}</h3>
            <span>{{ t('settings.agent.actionPolicyHelp') }}</span>
          </div>
          <div class="agent-editor__gate">
            <label class="agent-editor__switch">
              <input type="checkbox" :checked="hasGate" @change="toggleGate($event)" />
              <span>{{ t('settings.agent.customGate') }}</span>
            </label>
            <template v-if="hasGate">
              <div class="agent-editor__field-grid">
                <div class="agent-editor__field">
                  <label for="agent-default-verdict">{{
                    t('settings.agent.defaultVerdict')
                  }}</label>
                  <select
                    id="agent-default-verdict"
                    :value="gateString('defaultVerdict', 'escalate')"
                    @change="
                      setGateString('defaultVerdict', ($event.target as HTMLSelectElement).value)
                    "
                  >
                    <option value="allow">{{ t('settings.agent.verdict.allow') }}</option>
                    <option value="escalate">{{ t('settings.agent.verdict.escalate') }}</option>
                    <option value="deny">{{ t('settings.agent.verdict.deny') }}</option>
                  </select>
                </div>
                <NoxTextField
                  id="agent-escalation-timeout"
                  :model-value="gateNumber('escalationTimeoutMs', 120000)"
                  :error="fieldErrors['gate.escalationTimeoutMs']"
                  :label="t('settings.agent.escalationTimeout')"
                  @update:model-value="setGateNumber('escalationTimeoutMs', $event)"
                />
                <NoxTextField
                  id="agent-max-permissions"
                  :model-value="gateNumber('maxPendingPermissions', 8)"
                  :error="fieldErrors['gate.maxPendingPermissions']"
                  :label="t('settings.agent.maxPendingPermissions')"
                  @update:model-value="setGateNumber('maxPendingPermissions', $event)"
                />
              </div>
              <label class="agent-editor__switch">
                <input
                  type="checkbox"
                  :checked="gateHeuristicsEnabled()"
                  @change="setGateHeuristics($event)"
                />
                <span>{{ t('settings.agent.riskHeuristics') }}</span>
              </label>
              <div class="agent-editor__rules-note">
                <span>{{ plural('settings.agent.rules', gateRules) }}</span>
                <p>{{ t('settings.agent.rulesHelp') }}</p>
                <button type="button" @click="switchMode('json')">
                  {{ t('settings.agent.openGateJson') }} →
                </button>
              </div>
            </template>
          </div>
        </section>
      </template>

      <section v-else class="agent-editor__json" aria-labelledby="agent-json-title">
        <div class="agent-editor__section-copy">
          <p>{{ t('settings.editor.advancedSurface') }}</p>
          <h3 id="agent-json-title">{{ t('settings.agent.blueprintJson') }}</h3>
          <span>{{ t('settings.agent.blueprintJsonHelp') }}</span>
        </div>
        <div class="agent-editor__json-field">
          <div>
            <label for="agent-json">{{ t('settings.editor.jsonObject') }}</label>
            <button type="button" @click="formatJson()">
              {{ t('settings.editor.formatDocument') }}
            </button>
          </div>
          <textarea
            id="agent-json"
            v-model="jsonSource"
            :aria-invalid="jsonError !== undefined"
            spellcheck="false"
            @input="clearFeedback()"
          ></textarea>
          <p v-if="jsonError" class="agent-editor__error">{{ jsonError }}</p>
        </div>
      </section>

      <NoxNotice v-if="confirmingDelete" :title="t('settings.agent.removeQuestion')" tone="danger">
        <div class="agent-editor__delete-confirmation">
          <p>
            {{ t('settings.agent.removeWarning') }}
          </p>
          <div>
            <NoxButton variant="ghost" @click="confirmingDelete = false">{{
              t('common.cancel')
            }}</NoxButton>
            <NoxButton :busy="settings.mutation.type === 'saving'" @click="remove()">
              {{ t('settings.agent.remove') }}
            </NoxButton>
          </div>
        </div>
      </NoxNotice>
    </div>

    <footer class="agent-editor__actions">
      <NoxButton
        v-if="props.entryId !== undefined && !props.creating"
        variant="ghost"
        @click="confirmingDelete = true"
      >
        {{ t('settings.agent.remove') }}
      </NoxButton>
      <span v-else></span>
      <div>
        <span v-if="dirty" class="agent-editor__dirty">{{
          t('settings.editor.unsavedChanges')
        }}</span>
        <NoxButton :disabled="!dirty" variant="secondary" @click="resetEditor()">{{
          t('common.discard')
        }}</NoxButton>
        <NoxButton
          :busy="settings.mutation.type === 'saving'"
          :disabled="!dirty && !props.creating"
          @click="save()"
        >
          {{ t('settings.agent.save') }}
        </NoxButton>
      </div>
    </footer>
  </article>
</template>

<style scoped lang="scss">
.agent-editor {
  display: grid;
  min-height: 100%;
  grid-template-rows: auto 1fr auto;
}

.agent-editor__header {
  display: flex;
  min-height: 8rem;
  align-items: center;
  justify-content: space-between;
  gap: var(--nox-space-8);
  padding: var(--nox-space-6) var(--nox-space-8);
  border-bottom: 1px solid var(--nox-border-subtle);
  background: var(--nox-canvas-raised);
}

.agent-editor__header p,
.agent-editor__header span,
.agent-editor__section-copy p,
.agent-editor__section-copy span {
  margin: 0;
  color: var(--nox-text-muted);
  font-family: var(--nox-font-mono);
  font-size: var(--nox-text-xs);
  letter-spacing: 0.07em;
}

.agent-editor__header h2 {
  margin: var(--nox-space-1) 0 var(--nox-space-2);
  font-size: clamp(1.35rem, 3vw, 2rem);
  line-height: var(--nox-leading-tight);
}

.agent-editor__header-side {
  display: grid;
  justify-items: end;
  gap: var(--nox-space-3);
}

.agent-editor__badges,
.agent-editor__modes {
  display: flex;
  flex-wrap: wrap;
  justify-content: flex-end;
  gap: var(--nox-space-2);
}

.agent-editor__badges span {
  padding: var(--nox-space-2) var(--nox-space-3);
  border: 1px solid var(--nox-border-subtle);
  color: var(--nox-text-secondary);
  background: var(--nox-surface-1);
  font-size: 0.62rem;
}

.agent-editor__badges .agent-editor__badge--default {
  border-color: color-mix(in srgb, var(--nox-action-primary) 45%, var(--nox-border-subtle));
  color: var(--nox-action-primary);
}


.agent-editor__modes {
  padding: var(--nox-space-1);
  border: 1px solid var(--nox-border-subtle);
  background: var(--nox-surface-1);
}

.agent-editor__modes button {
  min-width: 4rem;
  padding: var(--nox-space-2) var(--nox-space-3);
  color: var(--nox-text-muted);
  background: transparent;
  font-family: var(--nox-font-mono);
  font-size: var(--nox-text-xs);
  cursor: pointer;
}

.agent-editor__modes button[aria-pressed='true'] {
  color: var(--nox-text-inverse);
  background: var(--nox-action-primary);
}

.agent-editor__content {
  display: grid;
  width: min(100%, 68rem);
  align-content: start;
  gap: var(--nox-space-6);
  justify-self: center;
  padding: var(--nox-space-8);
}

.agent-editor__section,
.agent-editor__json {
  display: grid;
  grid-template-columns: minmax(13rem, 0.36fr) minmax(0, 1fr);
  gap: var(--nox-space-8);
  padding: var(--nox-space-8) 0;
  border-top: 1px solid var(--nox-border-subtle);
}

.agent-editor__section:last-of-type,
.agent-editor__json {
  border-bottom: 1px solid var(--nox-border-subtle);
}

.agent-editor__section-copy h3 {
  margin: var(--nox-space-2) 0;
  font-size: var(--nox-text-md);
}

.agent-editor__section-copy span {
  display: block;
  max-width: 23rem;
  letter-spacing: 0;
  line-height: 1.65;
}

.agent-editor__fields,
.agent-editor__tasks,
.agent-editor__gate {
  display: grid;
  align-content: start;
  gap: var(--nox-space-5);
}

.agent-editor__field-grid,
.agent-editor__numeric-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: var(--nox-space-4);
}

.agent-editor__numeric-grid {
  grid-template-columns: repeat(3, minmax(0, 1fr));
}

.agent-editor__field {
  display: grid;
  align-content: start;
  gap: var(--nox-space-2);
}

.agent-editor__field > label,
.agent-editor__json-field label {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--nox-space-3);
  color: var(--nox-text-secondary);
  font-family: var(--nox-font-mono);
  font-size: var(--nox-text-xs);
  font-weight: 700;
  letter-spacing: var(--nox-tracking-system);
  text-transform: uppercase;
}

.agent-editor__field label small {
  color: var(--nox-text-muted);
  font-size: 0.62rem;
}

.agent-editor__field select,
.agent-editor__field textarea {
  width: 100%;
  border: 1px solid var(--nox-border-subtle);
  border-radius: var(--nox-radius-control);
  color: var(--nox-text-primary);
  background: var(--nox-surface-input);
  caret-color: var(--nox-action-primary);
}

.agent-editor__field select {
  height: var(--nox-control-height);
  padding: 0 var(--nox-space-4);
}

.agent-editor__field textarea {
  min-height: 18rem;
  resize: vertical;
  padding: var(--nox-space-4);
  line-height: 1.65;
}

.agent-editor__field select:focus,
.agent-editor__field textarea:focus {
  border-color: var(--nox-action-primary);
  outline: none;
  box-shadow: 0 0 0 1px var(--nox-action-primary);
}

.agent-editor__field--invalid select,
.agent-editor__field--invalid textarea {
  border-color: var(--nox-status-danger);
}

.agent-editor__error {
  margin: 0;
  color: var(--nox-status-danger);
  font-size: var(--nox-text-xs);
}

.agent-editor__grant-lists {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  align-items: start;
  gap: var(--nox-space-4);
}

.agent-editor__grant-list {
  min-width: 0;
  border: 1px solid var(--nox-border-subtle);
  background: color-mix(in srgb, var(--nox-surface-1) 72%, transparent);
}

.agent-editor__grant-list > header,
.agent-editor__grant > header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--nox-space-3);
}

.agent-editor__grant-list > header {
  min-height: 5rem;
  padding: var(--nox-space-4);
  border-bottom: 1px solid var(--nox-border-subtle);
  background: var(--nox-surface-1);
}

.agent-editor__grant-list > header > div,
.agent-editor__grant > header > div {
  display: grid;
  min-width: 0;
  gap: var(--nox-space-1);
}

.agent-editor__grant-list h4 {
  margin: 0;
  font-size: var(--nox-text-md);
}

.agent-editor__grant-list header span,
.agent-editor__grant-list header small,
.agent-editor__grant-list button,
.agent-editor__toolset-picker label,
.agent-editor__toolset-picker p,
.agent-editor__grant-empty,
.agent-editor__grant-scope,
.agent-editor__tool-allowlist {
  font-family: var(--nox-font-mono);
}

.agent-editor__grant-list > header span,
.agent-editor__grant-list > header small,
.agent-editor__grant > header span {
  color: var(--nox-text-muted);
  font-size: 0.62rem;
  letter-spacing: 0.06em;
}

.agent-editor__grant-list > header button {
  padding: var(--nox-space-2) var(--nox-space-3);
  border: 1px solid color-mix(in srgb, var(--nox-action-primary) 45%, var(--nox-border-subtle));
  color: var(--nox-action-primary);
  background: transparent;
  font-size: var(--nox-text-xs);
  cursor: pointer;
}

.agent-editor__toolset-picker {
  display: grid;
  gap: var(--nox-space-3);
  padding: var(--nox-space-4);
  border-bottom: 1px solid var(--nox-border-subtle);
  background: var(--nox-canvas-raised);
}

.agent-editor__toolset-picker label {
  color: var(--nox-text-muted);
  font-size: 0.62rem;
  letter-spacing: var(--nox-tracking-system);
  text-transform: uppercase;
}

.agent-editor__toolset-picker input,
.agent-editor__tool-allowlist > input {
  width: 100%;
  height: var(--nox-control-height);
  padding: 0 var(--nox-space-3);
  border: 1px solid var(--nox-border-subtle);
  border-radius: var(--nox-radius-control);
  color: var(--nox-text-primary);
  background: var(--nox-surface-input);
}

.agent-editor__toolset-picker input:focus,
.agent-editor__tool-allowlist > input:focus {
  border-color: var(--nox-action-primary);
  outline: none;
  box-shadow: 0 0 0 1px var(--nox-action-primary);
}

.agent-editor__toolset-picker > div {
  display: grid;
  max-height: 15rem;
  overflow-y: auto;
}

.agent-editor__toolset-picker > div > button {
  display: flex;
  min-width: 0;
  align-items: center;
  justify-content: space-between;
  gap: var(--nox-space-3);
  padding: var(--nox-space-3);
  border-top: 1px solid var(--nox-border-subtle);
  color: var(--nox-text-secondary);
  background: transparent;
  text-align: start;
  cursor: pointer;
}

.agent-editor__toolset-picker > div > button:hover {
  color: var(--nox-text-primary);
  background: var(--nox-surface-hover);
}

.agent-editor__toolset-picker > div > button > span:first-child {
  display: grid;
  min-width: 0;
  gap: var(--nox-space-1);
}

.agent-editor__toolset-picker > div > button > span:last-child {
  flex: none;
  color: var(--nox-action-primary);
  font-size: 0.58rem;
}

.agent-editor__toolset-picker strong,
.agent-editor__grant strong,
.agent-editor__tool-allowlist strong {
  overflow-wrap: anywhere;
}

.agent-editor__toolset-picker small,
.agent-editor__grant small,
.agent-editor__tool-allowlist small {
  color: var(--nox-text-muted);
  font-size: 0.62rem;
}

.agent-editor__toolset-picker p,
.agent-editor__grant-empty {
  margin: 0;
  color: var(--nox-text-muted);
  font-size: var(--nox-text-xs);
}

.agent-editor__grants {
  display: grid;
}

.agent-editor__grant {
  display: grid;
  gap: var(--nox-space-4);
  padding: var(--nox-space-4);
  border-bottom: 1px solid var(--nox-border-subtle);
}

.agent-editor__grant > header button {
  padding: 0;
  color: var(--nox-text-muted);
  background: transparent;
  font-size: 0.62rem;
  cursor: pointer;
}

.agent-editor__grant > header button:hover {
  color: var(--nox-status-danger);
}

.agent-editor__grant > p {
  margin: 0;
  color: var(--nox-text-muted);
  font-size: var(--nox-text-xs);
  line-height: 1.5;
}

.agent-editor__grant > .agent-editor__inventory-warning {
  color: var(--nox-status-warning);
}

.agent-editor__grant-scope {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  padding: var(--nox-space-1);
  border: 1px solid var(--nox-border-subtle);
  background: var(--nox-canvas);
}

.agent-editor__grant-scope button {
  display: flex;
  min-height: 2rem;
  align-items: center;
  justify-content: center;
  gap: var(--nox-space-2);
  padding: var(--nox-space-1) var(--nox-space-2);
  color: var(--nox-text-muted);
  background: transparent;
  font-size: 0.62rem;
  cursor: pointer;
}

.agent-editor__grant-scope button[aria-pressed='true'] {
  color: var(--nox-text-inverse);
  background: var(--nox-action-primary);
}

.agent-editor__grant-scope button:disabled {
  cursor: not-allowed;
  opacity: 0.45;
}

.agent-editor__grant-scope button small {
  color: currentcolor;
}

.agent-editor__memory-tools {
  grid-column: 1 / -1;
}

.agent-editor__tool-allowlist {
  display: grid;
  gap: var(--nox-space-3);
}

.agent-editor__tool-allowlist > div {
  display: grid;
  max-height: 18rem;
  overflow-y: auto;
  border-top: 1px solid var(--nox-border-subtle);
}

.agent-editor__tool-allowlist label {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr);
  align-items: start;
  gap: var(--nox-space-3);
  padding: var(--nox-space-3) var(--nox-space-2);
  border-bottom: 1px solid var(--nox-border-subtle);
  color: var(--nox-text-secondary);
  font-size: var(--nox-text-xs);
  cursor: pointer;
}

.agent-editor__tool-allowlist label > span {
  display: grid;
  gap: var(--nox-space-1);
}

.agent-editor__tool-allowlist input[type='checkbox'],
.agent-editor__switch input {
  width: 1rem;
  height: 1rem;
  accent-color: var(--nox-action-primary);
}

.agent-editor__grant-empty {
  padding: var(--nox-space-5) var(--nox-space-4);
}

.agent-editor__empty {
  margin: 0;
  padding: var(--nox-space-4);
  border: 1px dashed var(--nox-border-strong);
  color: var(--nox-text-muted);
  font-family: var(--nox-font-mono);
  font-size: var(--nox-text-sm);
}

.agent-editor__tasks fieldset,
.agent-editor__advanced-content fieldset {
  min-width: 0;
  margin: 0;
  padding: var(--nox-space-5);
  border: 1px solid var(--nox-border-subtle);
  background: var(--nox-surface-1);
}

.agent-editor__tasks legend,
.agent-editor__advanced-content legend {
  padding: 0 var(--nox-space-2);
  color: var(--nox-text-secondary);
  font-family: var(--nox-font-mono);
  font-size: var(--nox-text-xs);
  letter-spacing: var(--nox-tracking-system);
  text-transform: uppercase;
}

.agent-editor__advanced-group {
  border-top: 1px solid var(--nox-border-subtle);
  border-bottom: 1px solid var(--nox-border-subtle);
  background: color-mix(in srgb, var(--nox-surface-1) 70%, transparent);
}

.agent-editor__advanced-group summary {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr) auto auto;
  align-items: center;
  gap: var(--nox-space-4);
  padding: var(--nox-space-5);
  cursor: pointer;
  list-style: none;
}

.agent-editor__advanced-group summary::-webkit-details-marker {
  display: none;
}

.agent-editor__advanced-group summary span,
.agent-editor__advanced-group summary small {
  color: var(--nox-text-muted);
  font-family: var(--nox-font-mono);
  font-size: var(--nox-text-xs);
}

.agent-editor__advanced-group summary strong {
  font-size: var(--nox-text-sm);
}

.agent-editor__advanced-group summary::after {
  color: var(--nox-action-primary);
  content: '+';
  font-family: var(--nox-font-mono);
}

.agent-editor__advanced-group[open] summary::after {
  content: '−';
}

.agent-editor__advanced-content {
  display: grid;
  gap: var(--nox-space-5);
  padding: 0 var(--nox-space-5) var(--nox-space-5);
}

.agent-editor__rules-note {
  display: grid;
  gap: var(--nox-space-2);
  padding: var(--nox-space-4);
  border: 1px dashed var(--nox-border-strong);
}

.agent-editor__rules-note span,
.agent-editor__rules-note button {
  color: var(--nox-status-warning);
  font-family: var(--nox-font-mono);
  font-size: var(--nox-text-xs);
}

.agent-editor__rules-note p {
  margin: 0;
  color: var(--nox-text-muted);
  font-size: var(--nox-text-sm);
}

.agent-editor__rules-note button {
  width: fit-content;
  padding: 0;
  background: transparent;
  cursor: pointer;
}

.agent-editor__json-field {
  display: grid;
  min-width: 0;
  gap: var(--nox-space-2);
}

.agent-editor__json-field > div {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--nox-space-4);
}

.agent-editor__json-field button {
  padding: var(--nox-space-1) var(--nox-space-2);
  color: var(--nox-text-muted);
  background: transparent;
  font-family: var(--nox-font-mono);
  font-size: var(--nox-text-xs);
  cursor: pointer;
}

.agent-editor__json-field button:hover {
  color: var(--nox-action-primary);
}

.agent-editor__json-field textarea {
  width: 100%;
  min-height: 38rem;
  resize: vertical;
  padding: var(--nox-space-4);
  border: 1px solid var(--nox-border-subtle);
  border-radius: var(--nox-radius-control);
  color: var(--nox-code-inline);
  background: var(--nox-surface-input);
  font-family: var(--nox-font-mono);
  font-size: var(--nox-text-sm);
  line-height: 1.65;
  tab-size: 2;
  caret-color: var(--nox-action-primary);
}

.agent-editor__json-field textarea:focus {
  border-color: var(--nox-action-primary);
  outline: none;
  box-shadow: 0 0 0 1px var(--nox-action-primary);
}

.agent-editor__json-field textarea[aria-invalid='true'] {
  border-color: var(--nox-status-danger);
}

.agent-editor__delete-confirmation {
  display: grid;
  gap: var(--nox-space-3);
}

.agent-editor__delete-confirmation > div {
  display: flex;
  justify-content: flex-end;
  gap: var(--nox-space-2);
}

.agent-editor__actions {
  display: flex;
  min-height: 5rem;
  align-items: center;
  justify-content: space-between;
  gap: var(--nox-space-4);
  padding: var(--nox-space-4) var(--nox-space-8);
  border-top: 1px solid var(--nox-border-subtle);
  background: color-mix(in srgb, var(--nox-canvas-raised) 96%, transparent);
}

.agent-editor__actions > div {
  display: flex;
  align-items: center;
  gap: var(--nox-space-3);
}

.agent-editor__dirty {
  color: var(--nox-status-warning);
  font-family: var(--nox-font-mono);
  font-size: 0.62rem;
  letter-spacing: 0.08em;
}

@media (max-width: 70rem) {
  .agent-editor__grant-lists {
    grid-template-columns: 1fr;
  }

  .agent-editor__numeric-grid {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
}

@media (max-width: 60rem) {
  .agent-editor__header,
  .agent-editor__content,
  .agent-editor__actions {
    padding-inline: var(--nox-space-5);
  }

  .agent-editor__section,
  .agent-editor__json {
    grid-template-columns: 1fr;
  }
}

@media (max-width: 36rem) {
  .agent-editor__header,
  .agent-editor__actions,
  .agent-editor__actions > div {
    align-items: stretch;
    flex-direction: column;
  }

  .agent-editor__header-side {
    justify-items: start;
  }

  .agent-editor__badges,
  .agent-editor__modes {
    justify-content: flex-start;
  }

  .agent-editor__field-grid,
  .agent-editor__numeric-grid {
    grid-template-columns: 1fr;
  }

  .agent-editor__advanced-group summary {
    grid-template-columns: 1fr auto;
  }

  .agent-editor__advanced-group summary span,
  .agent-editor__advanced-group summary small {
    grid-column: 1 / -1;
  }
}
</style>
