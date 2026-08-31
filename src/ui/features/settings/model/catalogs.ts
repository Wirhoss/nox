/**
 * The choices behind every field that names a provider or a model.
 *
 * Configuration is full of names that belong to something else: an agent names
 * a provider, a provider's model list names models the endpoint serves, a
 * memory names both. Every one of them used to be typed, and a typo in any of
 * them produces a document that saves cleanly and fails at the first run. What
 * exists is knowable — the configured entries, and what each live provider
 * reports — so it is offered instead.
 *
 * Kept out of the components because three editors ask the same question and
 * three answers would drift; kept out of the store because it is derivation,
 * not state.
 */

import type { ProviderInventory, ProviderModelInventory } from '../api/settings.api'

interface CatalogOption {
  /** Shown beside the ID: what kind of model it is, or where the name came from. */
  readonly note?: string
  readonly value: string
}

type Translate = (
  key: string,
  parameters?: Readonly<Record<string, boolean | number | string>>,
) => string

/**
 * Every configured provider, including one that failed to activate.
 *
 * An unavailable provider is still a legitimate choice: repairing a broken
 * endpoint and pointing an agent at it are two separate acts, and hiding it
 * here would make the second one impossible until the first is done.
 */
function providerOptions(
  inventory: readonly ProviderInventory[],
  t: Translate,
): readonly CatalogOption[] {
  return inventory.map((provider) => ({
    note: provider.available ? provider.type : t('settings.catalog.providerUnavailable'),
    value: provider.id,
  }))
}

/** What one model is: the kind it was declared as, or that the endpoint listed it. */
function modelNote(model: ProviderModelInventory, t: Translate): string {
  if (!model.configured) return t('settings.catalog.reported')
  return model.kind === 'embedding'
    ? t('settings.catalog.embedding')
    : t('settings.catalog.chat')
}

/**
 * The models one provider serves. Declared models come first: they are the ones
 * this installation has already said something about, and their metadata is
 * what context accounting and vector storage depend on.
 */
function modelOptions(
  inventory: readonly ProviderInventory[],
  providerId: string | undefined,
  t: Translate,
): readonly CatalogOption[] {
  if (providerId === undefined || providerId.length === 0) return []
  const provider = inventory.find((candidate) => candidate.id === providerId)
  if (provider === undefined) return []
  return [...provider.models]
    .sort((left, right) => Number(right.configured) - Number(left.configured))
    .map((model) => ({ note: modelNote(model, t), value: model.modelId }))
}

/**
 * Why a model field has nothing to offer, when it has nothing.
 *
 * Answered rather than left blank: an empty list means one of several different
 * things — no provider chosen yet, an endpoint that refused the question, an
 * instance that has not activated — and each of them is a different next step
 * for whoever is looking at the empty field.
 */
function modelCatalogProblem(
  inventory: readonly ProviderInventory[],
  providerId: string | undefined,
  t: Translate,
): string | undefined {
  if (providerId === undefined || providerId.length === 0) {
    return t('settings.catalog.chooseProviderFirst')
  }
  const provider = inventory.find((candidate) => candidate.id === providerId)
  if (provider === undefined) return t('settings.catalog.unknownProvider', { provider: providerId })
  if (!provider.available) {
    return t('settings.catalog.providerProblem', {
      problem: provider.problem ?? t('settings.catalog.providerUnavailable'),
    })
  }
  if (provider.models.length > 0) return undefined
  return provider.reported
    ? t('settings.catalog.noModelsReported')
    : t('settings.catalog.modelsUnlistable', {
        problem: provider.reportProblem ?? t('settings.catalog.noModelList'),
      })
}

export { modelCatalogProblem, modelOptions, providerOptions }

export type { CatalogOption }
