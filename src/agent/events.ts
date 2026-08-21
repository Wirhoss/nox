import type { ProviderError } from '../provider/error';
import type { Usage } from '../provider/stream';
import type { PermissionRequest, PermissionResolution } from '../tool/gate';
import type { Message } from './context/message';

/** How a run ended. `maxIterations` means the answer is probably truncated. */
type RunStatus = 'aborted' | 'completed' | 'failed' | 'maxIterations';

/**
 * What put the run on the queue. With deferred results waking an idle runner,
 * a consumer cannot otherwise tell a reply from the agent moving on its own.
 */
type RunTrigger = 'deferredResult' | 'steer' | 'user';

/**
 * Everything an observer of a session can see.
 *
 * `message` covers every append, including the `folded` and `compacted` events
 * the context writes on its own — they are messages, not a separate concern.
 * Fragments are the live view of a reply that is still being written; the
 * `message` that follows is the settled one.
 *
 * No event carries a run id: runs never overlap, so everything between a
 * `runStarted` and its `runCompleted` belongs to that run.
 */
type AgentEvent =
  | { type: 'assistantReasoningFragment'; text: string }
  | { type: 'assistantTextFragment'; text: string }
  | { type: 'error'; error: Error }
  | { type: 'message'; message: Message }
  | { type: 'permissionRequested'; request: PermissionRequest }
  | { type: 'permissionResolved'; requestId: string; resolution: PermissionResolution }
  | { type: 'retry'; attempt: number; delayMs: number; error: ProviderError }
  | { type: 'runCompleted'; runId: string; status: RunStatus; durationMs: number; usage: Usage }
  | { type: 'runStarted'; runId: string; modelId: string; startedAt: Date; trigger: RunTrigger }
  | { type: 'usage'; usage: Usage };

export type { AgentEvent, RunStatus, RunTrigger };
