import type { SessionAuditAction, SessionAuditDecision } from '@/features/sessions/api/sessions.api'

type AuditTone = 'danger' | 'operational' | 'waiting'
type ActionDecisionView = Pick<
  SessionAuditDecision,
  'resolution' | 'stage' | 'verdict'
>
type ActionView = Pick<SessionAuditAction, 'decisions'>

function terminalDecision(action: ActionView): ActionDecisionView {
  for (let index = action.decisions.length - 1; index >= 0; index -= 1) {
    const decision = action.decisions[index]
    if (decision?.stage === 'gate') return decision
  }
  const decision = action.decisions[action.decisions.length - 1]
  if (decision === undefined) throw new Error('An audit action requires at least one decision.')
  return decision
}

function actionStatusKey(action: ActionView): string {
  const decision = terminalDecision(action)
  if (decision.verdict === 'allow') return 'audit.status.allowed'
  if (decision.verdict === 'deny') return 'audit.status.denied'
  switch (decision.resolution) {
    case 'approved':
      return 'audit.status.approved'
    case 'denied':
      return 'audit.status.denied'
    case 'timeout':
      return 'audit.status.timeout'
    case 'aborted':
      return 'audit.status.aborted'
    case undefined:
      return 'audit.status.pending'
  }
}

function actionTone(action: ActionView): AuditTone {
  const status = actionStatusKey(action)
  if (status === 'audit.status.allowed' || status === 'audit.status.approved') {
    return 'operational'
  }
  if (status === 'audit.status.pending') return 'waiting'
  return 'danger'
}

export { actionStatusKey, actionTone, terminalDecision }

export type { AuditTone }
