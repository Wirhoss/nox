/*
 * Playground session state.
 *
 * This module owns everything about *running* a session — the REST calls, the
 * SSE subscription, reconnection, and the reconciliation fallback — so the
 * components under `components/playground/` only render what they read here.
 *
 * Why a store and not component state: the transport has non-trivial failure
 * behaviour (exponential reconnect, a stall detector, and a poll that repairs
 * state when the stream silently dies) that is worth exercising without
 * mounting UI. Nano Stores is what Astro recommends for sharing state, and its
 * atoms are consumed by Svelte with plain `$store` syntax.
 *
 * Everything below the `--- actions` divider is the public surface; the timer
 * and stream plumbing above it is deliberately module-private.
 */

import { atom, computed, map } from 'nanostores';

import { errorMessage, request } from '../utils/api';
import { buildConversation } from '../utils/conversation';
import { GATEWAY_EVENT_NAMES } from '../utils/types';

import type {
  Activity,
  Blueprint,
  GatewayEvent,
  Message,
  Permission,
  RunStatus,
  RunUsage,
  SessionSnapshot,
  SessionSummary,
} from '../utils/types';

type ConnectionState = 'idle' | 'connecting' | 'connected' | 'reconnecting';

type StreamState = {
  connection: ConnectionState;
  /** Assistant prose accumulated from fragments since the last full message. */
  text: string;
  reasoning: string;
  reasoningCollapsed: boolean;
};

type RunState = {
  active: boolean;
  runId: string;
  status: Exclude<RunStatus, 'running'> | '';
  usage: RunUsage;
  durationMs: number;
  elapsedSeconds: number;
};

/** Points at a slot in `messages` holding an early copy of streamed content. */
type ProvisionalAssistantMessage = { index: number; role: 'assistant' | 'reasoning' };

type StatusState = {
  loading: boolean;
  creating: boolean;
  sending: boolean;
  aborting: boolean;
  clearing: boolean;
  deleting: boolean;
  error: string;
};

/** Activity rows kept in memory; the inspector only shows the newest few. */
const ACTIVITY_LIMIT = 50;
const RECONNECT_BASE_MS = 500;
const RECONNECT_CEILING_MS = 5_000;
/** No heartbeat for this long means the connection is dead but not errored. */
const STREAM_STALL_MS = 40_000;
const RECONCILE_INTERVAL_MS = 5_000;
const TICK_MS = 1_000;

const EMPTY_USAGE: RunUsage = { cacheReadTokens: 0, inputTokens: 0, outputTokens: 0 };

const IDLE_STREAM: StreamState = { connection: 'idle', reasoning: '', reasoningCollapsed: false, text: '' };
const IDLE_RUN: RunState = { active: false, durationMs: 0, elapsedSeconds: 0, runId: '', status: '', usage: EMPTY_USAGE };

const blueprints = atom<Blueprint[]>([]);
const sessions = atom<SessionSummary[]>([]);
const selectedBlueprintId = atom<string>('');
const currentSession = atom<SessionSummary | null>(null);
const messages = atom<Message[]>([]);
/** Parallel to `messages`; null where the gateway recorded no timestamp. */
const messageTimes = atom<Array<Date | null>>([]);
const permissions = atom<Permission[]>([]);
/** When the current run began, used as the last-resort time for a turn. */
const runStartedAt = atom<Date | null>(null);
const activities = atom<Activity[]>([]);
const stream = map<StreamState>({ ...IDLE_STREAM });
const run = map<RunState>({ ...IDLE_RUN });
const status = map<StatusState>({
  aborting: false,
  clearing: false,
  creating: false,
  deleting: false,
  error: '',
  loading: true,
  sending: false,
});

const selectedBlueprint = computed(
  [blueprints, selectedBlueprintId],
  (all, id) => all.find((item) => item.id === id) ?? null,
);

const blueprintSessions = computed(
  [sessions, selectedBlueprintId],
  (all, id) => all.filter((item) => item.blueprintId === id),
);

const messageCounts = computed(messages, (all) => ({
  assistant: all.filter((message) => message.role === 'assistant').length,
  toolCalls: all.filter((message) => message.role === 'toolCall').length,
  total: all.length,
}));

/** The transcript, grouped into user and agent turns. */
const conversationItems = computed(
  [messages, messageTimes, stream],
  (all, times, live) => buildConversation(all, times, Boolean(live.text || live.reasoning)),
);

/* --------------------------------------------------------------- internals */

let eventSource: EventSource | null = null;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let reconnectAttempt = 0;
let lastStreamSignalAt = 0;
let lastReconcileAt = 0;
let reconciling = false;
let elapsedTimer: ReturnType<typeof setInterval> | null = null;
/** Next SSE cursor to resume from, so a reconnect replays nothing twice. */
let cursor = 0;
let activitySequence = 0;
/**
 * Text of a message rendered optimistically. The gateway echoes user messages
 * back over the stream; matching on this suppresses the duplicate.
 */
let optimisticUserText = '';
/**
 * Live fragments that were committed to `messages` early so a tool action can
 * be pinned after them. The gateway still sends the settled versions, which
 * replace these in place rather than appending a duplicate.
 */
let provisionalAssistantMessages: ProvisionalAssistantMessage[] = [];

const sessionPath = (sessionId: string, suffix = ''): string =>
  `/api/v1/sessions/${encodeURIComponent(sessionId)}${suffix}`;

const setError = (error: unknown, fallback: string): void => {
  status.setKey('error', errorMessage(error, fallback));
};

/** Marks a run as no longer producing output, without asserting an outcome. */
const settleRun = (): void => {
  run.setKey('active', false);
  status.setKey('sending', false);
  stream.setKey('text', '');
  provisionalAssistantMessages = [];
  stopElapsedTimer();
};

/** Appends a message and the moment it landed. */
const appendMessage = (message: Message, time: Date | null = new Date()): void => {
  messages.set([...messages.get(), message]);
  messageTimes.set([...messageTimes.get(), time]);
};

/**
 * Commits whatever is currently streaming into the transcript.
 *
 * Providers can stream prose, start a tool, and only then emit the settled
 * assistant messages. Without this the tool action would render *above* the
 * text that introduced it, so the fragments are pinned first and marked
 * provisional for later replacement.
 */
const flushLiveContentBeforeAction = (): void => {
  const time = new Date();
  const live = stream.get();

  if (live.reasoning) {
    provisionalAssistantMessages = [
      ...provisionalAssistantMessages,
      { index: messages.get().length, role: 'reasoning' },
    ];
    appendMessage({ content: [{ text: live.reasoning, type: 'text' }], role: 'reasoning' }, time);
    stream.setKey('reasoning', '');
  }

  if (live.text) {
    provisionalAssistantMessages = [
      ...provisionalAssistantMessages,
      { index: messages.get().length, role: 'assistant' },
    ];
    appendMessage({ content: [{ text: live.text, type: 'text' }], role: 'assistant' }, time);
    stream.setKey('text', '');
  }
};

const stopElapsedTimer = (): void => {
  if (elapsedTimer) clearInterval(elapsedTimer);
  elapsedTimer = null;
};

const scheduleReconnect = (delayMs: number): void => {
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connectStream();
  }, delayMs);
};

/**
 * Adopts a snapshot's messages and their timestamps.
 *
 * `messageEntries` is the timestamped view of the same list. It is only
 * trusted when it lines up one-to-one with `messages`; otherwise the times are
 * dropped rather than misaligned, and the transcript renders without them.
 */
const adoptMessages = (snapshot: SessionSnapshot): void => {
  messages.set(snapshot.messages);
  messageTimes.set(
    snapshot.messageEntries?.length === snapshot.messages.length
      ? snapshot.messageEntries.map((entry) => new Date(entry.createdAt))
      : snapshot.messages.map(() => null),
  );
};

/**
 * Rebuilds the activity list from a snapshot. The gateway sends only the tail,
 * so cursors are derived backwards from the total count to stay stable.
 */
const adoptActivities = (snapshot: SessionSnapshot): void => {
  activitySequence = Number.isFinite(snapshot.activityCount)
    ? snapshot.activityCount
    : snapshot.recentActivities.length;
  const firstSequence = activitySequence - snapshot.recentActivities.length + 1;
  activities.set(snapshot.recentActivities.map((activity, index) => ({
    ...activity,
    cursor: firstSequence + index,
    receivedAt: new Date(activity.receivedAt),
  })));
};

const closeStream = (): void => {
  if (reconnectTimer) clearTimeout(reconnectTimer);
  reconnectTimer = null;
  reconnectAttempt = 0;
  eventSource?.close();
  eventSource = null;
  stream.setKey('connection', 'idle');
};

const connectStream = (): void => {
  const session = currentSession.get();
  if (!session) return;
  if (reconnectTimer) clearTimeout(reconnectTimer);
  reconnectTimer = null;
  eventSource?.close();
  eventSource = null;
  stream.setKey('connection', 'connecting');

  const source = new EventSource(sessionPath(session.sessionId, `/events?from=${cursor}`));
  eventSource = source;

  const consumeServerEvent = (messageEvent: MessageEvent<string>): void => {
    lastStreamSignalAt = Date.now();
    if (typeof messageEvent.data !== 'string' || !messageEvent.data.trim()) return;
    try {
      const event = JSON.parse(messageEvent.data) as GatewayEvent;
      const eventCursor = Number(messageEvent.lastEventId);
      if (Number.isFinite(eventCursor)) cursor = Math.max(cursor, eventCursor + 1);
      handleEvent(event);
    } catch {
      status.setKey('error', 'A malformed event was received from the session stream.');
    }
  };

  source.onopen = (): void => {
    reconnectAttempt = 0;
    lastStreamSignalAt = Date.now();
    stream.setKey('connection', 'connected');
  };

  source.addEventListener('heartbeat', () => {
    if (eventSource === source) lastStreamSignalAt = Date.now();
  });

  source.onerror = (event): void => {
    // Nox uses a named SSE `error` event for agent failures. EventSource also
    // dispatches a native `error` Event during reconnects; only the former is
    // a MessageEvent with JSON data.
    if (event instanceof MessageEvent) {
      consumeServerEvent(event as MessageEvent<string>);
      return;
    }
    if (eventSource === source) {
      source.close();
      eventSource = null;
      stream.setKey('connection', 'reconnecting');
      const delay = Math.min(RECONNECT_BASE_MS * (2 ** reconnectAttempt), RECONNECT_CEILING_MS);
      reconnectAttempt += 1;
      scheduleReconnect(delay);
    }
  };

  for (const eventType of GATEWAY_EVENT_NAMES) {
    source.addEventListener(eventType, (rawEvent) => {
      if (rawEvent instanceof MessageEvent) consumeServerEvent(rawEvent as MessageEvent<string>);
    });
  }
};

const handleEvent = (event: GatewayEvent): void => {
  if (event.type !== 'assistantTextFragment' && event.type !== 'assistantReasoningFragment') {
    activitySequence += 1;
    activities.set([
      ...activities.get().slice(-(ACTIVITY_LIMIT - 1)),
      { cursor: activitySequence, event, receivedAt: new Date() },
    ]);
  }

  if (event.type === 'runStarted') {
    runStartedAt.set(new Date(event.startedAt));
    run.set({ active: true, durationMs: 0, elapsedSeconds: 0, runId: event.runId, status: '', usage: run.get().usage });
    stream.setKey('reasoning', '');
    stream.setKey('reasoningCollapsed', false);
    provisionalAssistantMessages = [];
    startElapsedTimer();
    return;
  }

  if (event.type === 'runCompleted') {
    run.set({
      active: false,
      durationMs: event.durationMs,
      elapsedSeconds: Math.max(0, Math.round(event.durationMs / 1000)),
      runId: event.runId,
      status: event.status,
      usage: event.usage,
    });
    status.setKey('sending', false);
    stream.setKey('text', '');
    stream.setKey('reasoningCollapsed', true);
    provisionalAssistantMessages = [];
    stopElapsedTimer();
    return;
  }

  if (event.type === 'assistantTextFragment') {
    // The first prose token means reasoning is done; fold it away.
    if (stream.get().reasoning) stream.setKey('reasoningCollapsed', true);
    stream.setKey('text', stream.get().text + event.text);
    run.setKey('active', true);
    return;
  }

  if (event.type === 'assistantReasoningFragment') {
    stream.setKey('reasoning', stream.get().reasoning + event.text);
    run.setKey('active', true);
    return;
  }

  if (event.type === 'message') {
    // A tool call closes whatever was being streamed, so it lands after it.
    if (event.message.role === 'toolCall') flushLiveContentBeforeAction();

    const role = event.message.role;
    if (role === 'user' && optimisticUserText && messageText(event.message) === optimisticUserText) {
      // Already on screen from `sendMessage`; drop the echo.
      optimisticUserText = '';
    } else if (role === 'reasoning' || role === 'assistant') {
      replaceProvisionalOrAppend(event.message, role);
    } else {
      appendMessage(event.message);
    }

    // A settled message supersedes the fragments that built it.
    if (role === 'reasoning') {
      stream.setKey('reasoning', '');
      stream.setKey('reasoningCollapsed', false);
    }
    if (role === 'assistant') stream.setKey('text', '');
    return;
  }

  if (event.type === 'permissionRequest') {
    permissions.set([...permissions.get().filter((item) => item.requestId !== event.requestId), event]);
    run.setKey('active', true);
    return;
  }

  if (event.type === 'permissionResolved') {
    permissions.set(permissions.get().filter((item) => item.requestId !== event.requestId));
    return;
  }

  if (event.type === 'error') {
    status.setKey('error', event.message);
    stream.setKey('reasoningCollapsed', true);
    settleRun();
  }
};

/**
 * Swaps a settled message into the slot its provisional copy occupies, so the
 * turn keeps its original order. Falls back to appending when no provisional
 * copy is waiting, or when the slot no longer holds the expected role.
 */
const replaceProvisionalOrAppend = (message: Message, role: 'assistant' | 'reasoning'): void => {
  const pendingIndex = provisionalAssistantMessages.findIndex((item) => item.role === role);
  const pending = provisionalAssistantMessages[pendingIndex];

  if (pending && messages.get()[pending.index]?.role === role) {
    messages.set(messages.get().with(pending.index, message));
    messageTimes.set(messageTimes.get().with(pending.index, new Date()));
    provisionalAssistantMessages = provisionalAssistantMessages.filter((_, index) => index !== pendingIndex);
    return;
  }
  appendMessage(message);
};

/** Local copy of `textContent`, kept here so the store has no UI dependency. */
const messageText = (message: Message): string =>
  message.role === 'user' || message.role === 'assistant' || message.role === 'reasoning'
    ? message.content.filter((item) => item.type === 'text').map((item) => item.text).join('\n')
    : '';

/**
 * Repairs state when the stream misses a terminal event.
 *
 * SSE stays the primary transport; this only fires while a run is believed
 * active, and bails out unless the snapshot describes the *same* run that is
 * being tracked, so a newer run is never clobbered by a stale poll.
 */
const reconcileActiveRun = async (): Promise<void> => {
  const session = currentSession.get();
  if (!session || !run.get().active || reconciling) return;
  const sessionId = session.sessionId;
  reconciling = true;
  try {
    const snapshot = await request<SessionSnapshot>(sessionPath(sessionId));
    if (currentSession.get()?.sessionId !== sessionId) return;
    const latestRun = snapshot.latestRun;
    if (!latestRun) return;

    const trackedRunId = run.get().runId;
    if (trackedRunId && latestRun.runId !== trackedRunId) return;
    if (!trackedRunId) {
      // No id yet (the run was started optimistically by send). Only adopt a
      // run that plausibly started after we asked for one.
      const expectedAfter = (runStartedAt.get()?.getTime() ?? Date.now()) - 1_000;
      if (new Date(latestRun.startedAt).getTime() < expectedAfter) return;
      run.setKey('runId', latestRun.runId);
    }
    if (latestRun.status === 'running') return;

    adoptMessages(snapshot);
    adoptActivities(snapshot);
    provisionalAssistantMessages = [];
    run.set({
      active: false,
      durationMs: latestRun.durationMs ?? 0,
      elapsedSeconds: Math.max(0, Math.round((latestRun.durationMs ?? 0) / 1000)),
      runId: run.get().runId,
      status: latestRun.status,
      usage: latestRun.usage,
    });
    status.setKey('sending', false);
    stream.set({ ...IDLE_STREAM, connection: stream.get().connection, reasoningCollapsed: true });
    stopElapsedTimer();
  } catch {
    // SSE remains the primary transport; reconciliation retries quietly.
  } finally {
    reconciling = false;
  }
};

/**
 * One-second tick driving three things: the elapsed counter, the periodic
 * reconcile, and the stall detector that forces a reconnect when the stream
 * goes quiet without erroring.
 */
const startElapsedTimer = (): void => {
  stopElapsedTimer();
  elapsedTimer = setInterval(() => {
    const now = Date.now();
    const startedAt = runStartedAt.get();
    if (startedAt) run.setKey('elapsedSeconds', Math.floor((now - startedAt.getTime()) / 1000));

    if (run.get().active && now - lastReconcileAt >= RECONCILE_INTERVAL_MS) {
      lastReconcileAt = now;
      void reconcileActiveRun();
    }

    if (eventSource && stream.get().connection === 'connected' && now - lastStreamSignalAt >= STREAM_STALL_MS) {
      eventSource.close();
      eventSource = null;
      stream.setKey('connection', 'reconnecting');
      scheduleReconnect(RECONNECT_BASE_MS);
    }
  }, TICK_MS);
};

/* ----------------------------------------------------------------- actions */

const loadPlayground = async (): Promise<void> => {
  status.setKey('loading', true);
  status.setKey('error', '');
  try {
    const [blueprintData, sessionData] = await Promise.all([
      request<Blueprint[]>('/api/v1/blueprints'),
      request<SessionSummary[]>('/api/v1/sessions?limit=100'),
    ]);
    blueprints.set(blueprintData);
    sessions.set(sessionData);

    const params = new URLSearchParams(window.location.search);
    const requestedSession = params.get('session');
    const requestedBlueprint = params.get('blueprint');
    if (requestedSession) {
      await openSession(requestedSession);
    } else {
      selectedBlueprintId.set(
        blueprintData.some((item) => item.id === requestedBlueprint)
          ? requestedBlueprint!
          : (blueprintData[0]?.id ?? ''),
      );
    }
  } catch (error) {
    setError(error, 'The Playground could not be loaded.');
  } finally {
    status.setKey('loading', false);
  }
};

const openSession = async (sessionId: string): Promise<void> => {
  closeStream();
  stopElapsedTimer();
  status.setKey('error', '');
  stream.set({ ...IDLE_STREAM });
  run.set({ ...IDLE_RUN });
  activities.set([]);
  permissions.set([]);
  activitySequence = 0;
  runStartedAt.set(null);
  provisionalAssistantMessages = [];

  try {
    const snapshot = await request<SessionSnapshot>(sessionPath(sessionId));
    currentSession.set(snapshot.session);
    selectedBlueprintId.set(snapshot.session.blueprintId);
    adoptMessages(snapshot);
    adoptActivities(snapshot);
    cursor = snapshot.eventCursor;

    if (snapshot.latestRun) {
      const startedAt = new Date(snapshot.latestRun.startedAt);
      runStartedAt.set(startedAt);
      run.set({
        active: false,
        durationMs: snapshot.latestRun.durationMs ?? 0,
        // A run still in flight has no duration; measure from its start instead.
        elapsedSeconds: snapshot.latestRun.durationMs === null
          ? Math.max(0, Math.floor((Date.now() - startedAt.getTime()) / 1000))
          : Math.max(0, Math.round(snapshot.latestRun.durationMs / 1000)),
        runId: snapshot.latestRun.runId,
        status: snapshot.latestRun.status === 'running' ? '' : snapshot.latestRun.status,
        usage: snapshot.latestRun.usage,
      });
    }

    const pendingPermissions = await request<Permission[]>(sessionPath(sessionId, '/permissions'));
    permissions.set(pendingPermissions);
    // A pending permission means the run is parked, not finished.
    run.setKey('active', snapshot.isRunning || pendingPermissions.length > 0);
    if (run.get().active) startElapsedTimer();

    window.history.replaceState({}, '', `/playground?session=${encodeURIComponent(sessionId)}`);
    connectStream();
  } catch (error) {
    currentSession.set(null);
    messages.set([]);
    messageTimes.set([]);
    setError(error, 'The session could not be opened.');
  }
};

const createSession = async (): Promise<void> => {
  const blueprintId = selectedBlueprintId.get();
  if (!blueprintId) return;
  status.setKey('creating', true);
  status.setKey('error', '');
  try {
    const created = await request<{ sessionId: string }>('/api/v1/sessions', {
      body: JSON.stringify({ blueprintId }),
      method: 'POST',
    });
    const now = new Date().toISOString();
    sessions.set([{ blueprintId, createdAt: now, sessionId: created.sessionId, updatedAt: now }, ...sessions.get()]);
    await openSession(created.sessionId);
  } catch (error) {
    setError(error, 'A session could not be created.');
  } finally {
    status.setKey('creating', false);
  }
};

const sendMessage = async (text: string): Promise<void> => {
  const session = currentSession.get();
  const trimmed = text.trim();
  if (!trimmed || !session || status.get().sending) return;

  status.setKey('error', '');
  status.setKey('sending', true);
  runStartedAt.set(new Date());
  // The run id arrives with `runStarted`; until then the run is tracked blind.
  run.set({ ...IDLE_RUN, active: true, usage: run.get().usage });
  stream.setKey('reasoning', '');
  stream.setKey('reasoningCollapsed', false);
  provisionalAssistantMessages = [];
  startElapsedTimer();

  optimisticUserText = trimmed;
  appendMessage({ content: [{ text: trimmed, type: 'text' }], role: 'user' });

  try {
    await request<{ delivery: 'queued' | 'steered' }>(sessionPath(session.sessionId, '/messages'), {
      body: JSON.stringify({ text: trimmed }),
      method: 'POST',
    });
  } catch (error) {
    // Roll the optimistic message back off the transcript.
    messages.set(messages.get().slice(0, -1));
    messageTimes.set(messageTimes.get().slice(0, -1));
    optimisticUserText = '';
    settleRun();
    setError(error, 'The message could not be sent.');
  }
};

const abortRun = async (): Promise<void> => {
  const session = currentSession.get();
  if (!session || status.get().aborting) return;
  status.setKey('aborting', true);
  try {
    await request<{ aborted: boolean }>(sessionPath(session.sessionId, '/abort'), { method: 'POST' });
    settleRun();
  } catch (error) {
    setError(error, 'The run could not be stopped.');
  } finally {
    status.setKey('aborting', false);
  }
};

const resolvePermission = async (permission: Permission, approved: boolean): Promise<void> => {
  const session = currentSession.get();
  if (!session) return;
  try {
    await request<{ resolved: boolean }>(
      sessionPath(session.sessionId, `/permissions/${encodeURIComponent(permission.requestId)}`),
      { body: JSON.stringify({ approved }), method: 'POST' },
    );
    permissions.set(permissions.get().filter((item) => item.requestId !== permission.requestId));
  } catch (error) {
    setError(error, 'The permission decision could not be sent.');
  }
};

/** Deletes the stored conversation and starts a fresh session on the same blueprint. */
const clearSession = async (): Promise<void> => {
  const session = currentSession.get();
  if (!session || status.get().clearing) return;
  status.setKey('clearing', true);
  const { blueprintId, sessionId } = session;
  try {
    closeStream();
    await request<void>(sessionPath(sessionId), { method: 'DELETE' });
    sessions.set(sessions.get().filter((item) => item.sessionId !== sessionId));
    currentSession.set(null);
    messages.set([]);
    messageTimes.set([]);
    selectedBlueprintId.set(blueprintId);
    await createSession();
  } catch (error) {
    setError(error, 'The session could not be cleared.');
  } finally {
    status.setKey('clearing', false);
  }
};

/**
 * Deletes the session for good. Unlike `clearSession` no replacement is
 * created — the view falls back to the blueprint's start state.
 */
const deleteSession = async (): Promise<void> => {
  const session = currentSession.get();
  if (!session || status.get().deleting) return;
  status.setKey('deleting', true);
  const { blueprintId, sessionId } = session;
  try {
    closeStream();
    await request<void>(sessionPath(sessionId), { method: 'DELETE' });
    sessions.set(sessions.get().filter((item) => item.sessionId !== sessionId));
    currentSession.set(null);
    messages.set([]);
    messageTimes.set([]);
    permissions.set([]);
    activities.set([]);
    stream.set({ ...IDLE_STREAM });
    run.set({ ...IDLE_RUN });
    provisionalAssistantMessages = [];
    selectedBlueprintId.set(blueprintId);
    window.history.replaceState({}, '', `/playground?blueprint=${encodeURIComponent(blueprintId)}`);
  } catch (error) {
    setError(error, 'The session could not be deleted.');
  } finally {
    status.setKey('deleting', false);
  }
};

/** Switching blueprint detaches the current session rather than closing it. */
const selectBlueprint = (id: string): void => {
  selectedBlueprintId.set(id);
  const session = currentSession.get();
  if (!session || session.blueprintId !== id) {
    currentSession.set(null);
    messages.set([]);
    messageTimes.set([]);
    permissions.set([]);
    activities.set([]);
    provisionalAssistantMessages = [];
    closeStream();
    window.history.replaceState({}, '', `/playground?blueprint=${encodeURIComponent(id)}`);
  }
};

const dismissError = (): void => {
  status.setKey('error', '');
};

/** Releases the stream and timer. Call from the host component's teardown. */
const teardownPlayground = (): void => {
  closeStream();
  stopElapsedTimer();
};

export {
  activities,
  blueprints,
  blueprintSessions,
  conversationItems,
  currentSession,
  messageCounts,
  messages,
  messageTimes,
  permissions,
  run,
  runStartedAt,
  selectedBlueprint,
  selectedBlueprintId,
  sessions,
  status,
  stream,
  abortRun,
  clearSession,
  createSession,
  deleteSession,
  dismissError,
  loadPlayground,
  openSession,
  resolvePermission,
  selectBlueprint,
  sendMessage,
  teardownPlayground,
};

export type {
  ConnectionState,
  ProvisionalAssistantMessage,
  RunState,
  StatusState,
  StreamState,
};
