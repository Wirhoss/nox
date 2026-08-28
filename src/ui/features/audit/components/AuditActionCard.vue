<script setup lang="ts">
import { useI18n } from '@/shared/i18n'
import { NoxStatus } from '@/shared/ui/NoxStatus'

import { actionStatusKey, actionTone } from '../model/action'

import type { SessionAuditAction, SessionAuditDecision } from '@/features/sessions/api/sessions.api'

interface Props {
  action: SessionAuditAction
}

const props = defineProps<Props>()
const { formatDate, t } = useI18n()

function moment(value: string): string {
  return formatDate(value, { dateStyle: 'medium', timeStyle: 'medium' })
}

function principal(reference: SessionAuditDecision['principal']): string {
  return `${reference.issuer}:${reference.subject}`
}

function responseLabel(
  execution: SessionAuditAction['responses'][number]['execution'],
): string {
  return t(`audit.response.${execution}`)
}

function responseState(response: SessionAuditAction['responses'][number]): string {
  if (response.isError) return t('audit.outcome.failed')
  if (response.execution === 'permissionPending') return t('audit.outcome.permissionPending')
  if (response.execution === 'deferredAck') return t('audit.outcome.deferred')
  return t('audit.outcome.completed')
}
</script>

<template>
  <details class="action">
    <summary class="action__summary">
      <span class="action__chevron" aria-hidden="true"></span>
      <span class="action__identity">
        <span>{{ props.action.toolSetId }} / {{ props.action.toolName }}</span>
        <strong>{{ props.action.title ?? props.action.toolName }}</strong>
      </span>
      <time :datetime="props.action.createdAt">{{ moment(props.action.createdAt) }}</time>
      <NoxStatus :label="t(actionStatusKey(props.action))" :tone="actionTone(props.action)" />
    </summary>

    <div class="action__body">
      <section class="action__request">
        <h3>{{ t('audit.detail.request') }}</h3>
        <dl>
          <div>
            <dt>{{ t('audit.field.authority') }}</dt>
            <dd><code>{{ props.action.authority }}</code></dd>
          </div>
          <div>
            <dt>{{ t('audit.field.track') }}</dt>
            <dd><code>{{ props.action.trackId }}</code></dd>
          </div>
          <div>
            <dt>{{ t('audit.field.run') }}</dt>
            <dd><code>{{ props.action.runId }}</code></dd>
          </div>
        </dl>
      </section>

      <section>
        <h3>{{ t('audit.detail.decision') }}</h3>
        <ol class="action__pipeline">
          <li v-for="decision in props.action.decisions" :key="decision.decisionId">
            <header>
              <strong>
                {{
                  decision.stage === 'authorization'
                    ? t('audit.stage.authorization')
                    : t('audit.stage.gate')
                }}
              </strong>
              <span>{{ t(`audit.verdict.${decision.verdict}`) }}</span>
            </header>
            <dl>
              <div>
                <dt>{{ t('audit.field.decidedBy') }}</dt>
                <dd><code>{{ decision.decidedBy }}</code></dd>
              </div>
              <div>
                <dt>{{ t('audit.field.principal') }}</dt>
                <dd><code>{{ principal(decision.principal) }}</code></dd>
              </div>
              <div v-if="decision.matchedGrant !== undefined">
                <dt>{{ t('audit.field.matchedGrant') }}</dt>
                <dd><code>{{ decision.matchedGrant }}</code></dd>
              </div>
              <div class="action__wide">
                <dt>{{ t('audit.field.reason') }}</dt>
                <dd>{{ decision.reason }}</dd>
              </div>
            </dl>

            <details class="action__params">
              <summary>{{ t('audit.field.parameters') }}</summary>
              <pre>{{ JSON.stringify(decision.params, undefined, 2) }}</pre>
            </details>

            <div v-if="decision.risk !== undefined" class="action__risk">
              <strong>{{ t('audit.detail.risk') }}</strong>
              <div class="action__effects">
                <span v-for="effect in decision.risk.effects" :key="effect">
                  {{ t(`audit.effect.${effect}`) }}
                </span>
              </div>
              <ul v-if="(decision.risk.resources?.length ?? 0) > 0">
                <li
                  v-for="resource in decision.risk.resources"
                  :key="`${resource.kind}:${resource.value}`"
                >
                  <span>{{ resource.kind }}</span>
                  <code>{{ resource.value }}</code>
                </li>
              </ul>
            </div>

            <ul v-if="(decision.signals?.length ?? 0) > 0" class="action__signals">
              <li v-for="signal in decision.signals" :key="`${signal.code}:${signal.resource ?? ''}`">
                <strong>{{ signal.code }}</strong>
                <p>{{ signal.reason }}</p>
                <code v-if="signal.resource !== undefined">{{ signal.resource }}</code>
              </li>
            </ul>

            <dl v-if="decision.verdict === 'escalate'" class="action__resolution">
              <div>
                <dt>{{ t('audit.field.resolution') }}</dt>
                <dd>
                  {{
                    decision.resolution === undefined
                      ? t('audit.status.pending')
                      : t(`audit.resolution.${decision.resolution}`)
                  }}
                </dd>
              </div>
              <div v-if="decision.scope !== undefined">
                <dt>{{ t('audit.field.scope') }}</dt>
                <dd>{{ t(`audit.scope.${decision.scope}`) }}</dd>
              </div>
              <div v-if="decision.resolvedBy !== undefined">
                <dt>{{ t('audit.field.resolvedBy') }}</dt>
                <dd><code>{{ principal(decision.resolvedBy) }}</code></dd>
              </div>
              <div v-if="decision.resolvedAt !== undefined">
                <dt>{{ t('audit.field.resolvedAt') }}</dt>
                <dd><time :datetime="decision.resolvedAt">{{ moment(decision.resolvedAt) }}</time></dd>
              </div>
            </dl>
          </li>
        </ol>
      </section>

      <section>
        <h3>{{ t('audit.detail.outcome') }}</h3>
        <p v-if="props.action.responses.length === 0" class="action__no-output">
          {{ t('audit.outcome.notObserved') }}
        </p>
        <ol v-else class="action__responses">
          <li v-for="(response, responseIndex) in props.action.responses" :key="`${response.execution}:${String(responseIndex)}`">
            <header>
              <div>
                <strong>{{ responseLabel(response.execution) }}</strong>
                <span :class="{ 'action__error': response.isError }">
                  {{ responseState(response) }}
                </span>
              </div>
              <div>
                <span>{{ t(`audit.trust.${response.trust}`) }}</span>
                <time :datetime="response.createdAt">{{ moment(response.createdAt) }}</time>
              </div>
            </header>

            <p v-if="response.content.length === 0" class="action__no-output">
              {{ t('audit.output.empty') }}
            </p>
            <div v-else class="action__output">
              <template v-for="(part, partIndex) in response.content" :key="`${part.type}:${String(partIndex)}`">
                <pre v-if="part.type === 'text'">{{ part.text }}</pre>
                <dl v-else-if="part.type === 'artifact'">
                  <div>
                    <dt>{{ t('audit.output.artifact') }}</dt>
                    <dd>{{ part.artifact.filename ?? part.artifact.artifactId }}</dd>
                  </div>
                  <div>
                    <dt>{{ t('audit.output.mediaType') }}</dt>
                    <dd><code>{{ part.artifact.mediaType }}</code></dd>
                  </div>
                  <div>
                    <dt>{{ t('audit.output.artifactId') }}</dt>
                    <dd><code>{{ part.artifact.artifactId }}</code></dd>
                  </div>
                </dl>
                <dl v-else>
                  <div>
                    <dt>{{ t(`audit.output.${part.type}`) }}</dt>
                    <dd><code>{{ part.source.url }}</code></dd>
                  </div>
                  <div v-if="part.source.mediaType !== undefined">
                    <dt>{{ t('audit.output.mediaType') }}</dt>
                    <dd><code>{{ part.source.mediaType }}</code></dd>
                  </div>
                </dl>
              </template>
            </div>
          </li>
        </ol>
      </section>
    </div>
  </details>
</template>

<style scoped lang="scss">
.action {
  border: 1px solid var(--nox-border-subtle);
  border-inline-start: 2px solid var(--nox-border-strong);
  border-radius: var(--nox-radius-control);
  background: color-mix(in srgb, var(--nox-surface-1) 92%, transparent);
  overflow: hidden;
}

.action[open] {
  border-inline-start-color: var(--nox-action-primary);
}

.action__summary {
  display: grid;
  min-height: 4.5rem;
  grid-template-columns: auto minmax(0, 1fr) auto auto;
  align-items: center;
  gap: var(--nox-space-4);
  padding: var(--nox-space-3) var(--nox-space-5);
  cursor: pointer;
  list-style: none;
}

.action__summary::-webkit-details-marker,
.action__params summary::-webkit-details-marker {
  display: none;
}

.action__chevron {
  width: 0.45rem;
  height: 0.45rem;
  border-right: 1px solid currentColor;
  border-bottom: 1px solid currentColor;
  color: var(--nox-text-muted);
  transform: rotate(-45deg);
}

.action[open] .action__chevron {
  transform: rotate(45deg);
}

.action__identity {
  display: grid;
  min-width: 0;
  gap: var(--nox-space-1);
}

.action__identity > span,
.action__summary time {
  color: var(--nox-text-muted);
  font-family: var(--nox-font-mono);
  font-size: var(--nox-text-xs);
}

.action__identity strong {
  color: var(--nox-text-primary);
  font-family: var(--nox-font-mono);
  font-size: var(--nox-text-sm);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.action__body {
  display: grid;
  gap: 1px;
  border-top: 1px solid var(--nox-border-subtle);
  background: var(--nox-border-subtle);
}

.action__body > section {
  display: grid;
  gap: var(--nox-space-4);
  padding: var(--nox-space-5);
  background: var(--nox-canvas-raised);
}

.action h3 {
  margin: 0;
  color: var(--nox-action-primary);
  font-family: var(--nox-font-mono);
  font-size: var(--nox-text-xs);
  letter-spacing: var(--nox-tracking-system);
  text-transform: uppercase;
}

.action dl {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: var(--nox-space-3) var(--nox-space-6);
  margin: 0;
}

.action dt {
  margin-bottom: var(--nox-space-1);
  color: var(--nox-text-muted);
  font-family: var(--nox-font-mono);
  font-size: 0.66rem;
  letter-spacing: 0.08em;
  text-transform: uppercase;
}

.action dd {
  margin: 0;
  color: var(--nox-text-secondary);
  font-size: var(--nox-text-sm);
  line-height: 1.5;
  overflow-wrap: anywhere;
}

.action code,
.action pre {
  color: var(--nox-code-inline);
  font-family: var(--nox-font-mono);
}

.action__wide {
  grid-column: 1 / -1;
}

.action__pipeline {
  display: grid;
  gap: var(--nox-space-3);
  margin: 0;
  padding: 0;
  list-style: none;
}

.action__pipeline > li {
  display: grid;
  gap: var(--nox-space-4);
  padding: var(--nox-space-4);
  border: 1px solid var(--nox-border-subtle);
  border-inline-start: 2px solid var(--nox-status-info);
  background: var(--nox-canvas);
}

.action__pipeline > li > header {
  display: flex;
  justify-content: space-between;
  gap: var(--nox-space-3);
  color: var(--nox-text-primary);
  font-family: var(--nox-font-mono);
  font-size: var(--nox-text-xs);
  letter-spacing: 0.08em;
  text-transform: uppercase;
}

.action__pipeline > li > header span {
  color: var(--nox-text-muted);
}

.action__params {
  border: 1px solid var(--nox-border-subtle);
}

.action__params summary {
  padding: var(--nox-space-2) var(--nox-space-3);
  color: var(--nox-text-muted);
  font-family: var(--nox-font-mono);
  font-size: var(--nox-text-xs);
  cursor: pointer;
}

.action__params pre {
  max-height: 14rem;
  margin: 0;
  padding: var(--nox-space-3);
  border-top: 1px solid var(--nox-border-subtle);
  overflow: auto;
  white-space: pre-wrap;
}

.action__risk {
  display: grid;
  gap: var(--nox-space-2);
  color: var(--nox-text-secondary);
  font-size: var(--nox-text-xs);
}

.action__effects {
  display: flex;
  flex-wrap: wrap;
  gap: var(--nox-space-2);
}

.action__effects span,
.action__risk li > span {
  padding: 0.2rem 0.42rem;
  border: 1px solid var(--nox-border-strong);
  border-radius: 999px;
  color: var(--nox-status-warning);
  font-family: var(--nox-font-mono);
  font-size: 0.66rem;
  text-transform: uppercase;
}

.action__risk ul,
.action__signals {
  display: grid;
  gap: var(--nox-space-2);
  margin: 0;
  padding: 0;
  list-style: none;
}

.action__risk li {
  display: flex;
  align-items: center;
  gap: var(--nox-space-2);
}

.action__signals li {
  padding: var(--nox-space-3);
  border-inline-start: 2px solid var(--nox-status-warning);
  background: var(--nox-surface-1);
}

.action__signals p {
  margin: var(--nox-space-1) 0;
  color: var(--nox-text-secondary);
  font-size: var(--nox-text-xs);
}

.action__resolution {
  padding-top: var(--nox-space-3);
  border-top: 1px solid var(--nox-border-subtle);
}

.action__responses {
  display: grid;
  gap: var(--nox-space-3);
  margin: 0;
  padding: 0;
  list-style: none;
}

.action__responses > li {
  border: 1px solid var(--nox-border-subtle);
  background: var(--nox-canvas);
  overflow: hidden;
}

.action__responses > li > header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--nox-space-4);
  padding: var(--nox-space-3) var(--nox-space-4);
  border-bottom: 1px solid var(--nox-border-subtle);
  font-family: var(--nox-font-mono);
  font-size: var(--nox-text-xs);
}

.action__responses > li > header > div {
  display: flex;
  align-items: center;
  gap: var(--nox-space-3);
}

.action__responses > li > header strong {
  color: var(--nox-text-primary);
}

.action__responses > li > header span,
.action__responses > li > header time,
.action__no-output {
  color: var(--nox-text-muted);
}

.action__output {
  display: grid;
  gap: 1px;
  background: var(--nox-border-subtle);
}

.action__output > pre,
.action__output > dl {
  margin: 0;
  padding: var(--nox-space-4);
  background: var(--nox-surface-1);
}

.action__output > pre {
  max-height: 24rem;
  color: var(--nox-text-secondary);
  font-family: var(--nox-font-mono);
  font-size: var(--nox-text-xs);
  line-height: 1.6;
  overflow: auto;
  overflow-wrap: anywhere;
  white-space: pre-wrap;
}

.action__no-output {
  margin: 0;
  padding: var(--nox-space-4);
  font-size: var(--nox-text-sm);
}

.action__error {
  color: var(--nox-status-danger) !important;
}

@media (max-width: 48rem) {
  .action__summary {
    grid-template-columns: auto minmax(0, 1fr);
  }

  .action__summary time,
  .action__summary :deep(.status) {
    grid-column: 2;
  }

  .action dl {
    grid-template-columns: minmax(0, 1fr);
  }

  .action__wide {
    grid-column: auto;
  }
}
</style>
