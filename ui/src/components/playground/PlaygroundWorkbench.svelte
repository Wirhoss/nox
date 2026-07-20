<script lang="ts">
	import { onDestroy, onMount, tick } from "svelte";
	import Avatar from "../shared/Avatar.svelte";
	import Markdown from "../shared/Markdown.svelte";

	type Content =
		| { type: "text"; text: string }
		| { type: "image"; source: { kind: "url"; url: string } | { kind: "base64"; mediaType: string; data: string } };
	type Message =
		| { role: "user" | "assistant" | "reasoning"; content: Content[] }
		| { role: "toolCall"; name: string; trackId: string; arguments: Record<string, unknown> }
		| { role: "toolResponse"; name: string; trackId: string; execution: "immediate" | "deferredAck" | "deferredResult"; response: Content[]; isError?: boolean };
	type Blueprint = {
		id: string;
		description: string;
		systemPrompt: string;
		coreTools: string[];
		lazyLoadedTools: string[];
		config: { providerId: string; modelId: string; maxIterations: number };
	};
	type SessionSummary = { sessionId: string; blueprintId: string; createdAt: string | number; updatedAt: string | number };
	type RunUsage = { inputTokens: number; outputTokens: number; cacheReadTokens: number };
	type RunSummary = {
		runId: string;
		modelId: string | null;
		status: "running" | "completed" | "aborted" | "maxIterations" | "failed";
		startedAt: string;
		completedAt: string | null;
		durationMs: number | null;
		usage: RunUsage;
	};
	type SessionSnapshot = {
		activityCount: number;
		eventCursor: number;
		isRunning: boolean;
		latestRun: RunSummary | null;
		messages: Message[];
		recentActivities: Array<{ cursor: number; event: ActivityEvent; receivedAt: string }>;
		session: SessionSummary;
	};
	type Permission = { requestId: string; toolName: string; toolArguments: Record<string, unknown>; reason: string };
	type GatewayEvent =
		| { type: "assistantTextFragment"; text: string }
		| { type: "assistantReasoningFragment"; text: string }
		| { type: "error"; message: string }
		| { type: "message"; message: Message }
		| { type: "permissionRequest"; requestId: string; toolName: string; toolArguments: Record<string, unknown>; reason: string }
		| { type: "permissionResolved"; requestId: string; resolution: "approved" | "denied" | "timeout" | "aborted" }
		| { type: "runStarted"; runId: string; modelId: string; startedAt: string }
		| { type: "runCompleted"; runId: string; status: "completed" | "aborted" | "maxIterations" | "failed"; durationMs: number; usage: RunUsage };
	type ActivityEvent = Exclude<GatewayEvent, { type: "assistantReasoningFragment" | "assistantTextFragment" }>;
	type Activity = { cursor: number; event: ActivityEvent; receivedAt: Date };
	type ApiError = { error?: { message?: string }; message?: string };

	let blueprints: Blueprint[] = [];
	let sessions: SessionSummary[] = [];
	let selectedBlueprintId = "";
	let currentSession: SessionSummary | null = null;
	let messages: Message[] = [];
	let permissions: Permission[] = [];
	let activities: Activity[] = [];
	let prompt = "";
	let streamingText = "";
	let reasoningText = "";
	let reasoningCollapsed = false;
	let loading = true;
	let creating = false;
	let sending = false;
	let running = false;
	let aborting = false;
	let clearing = false;
	let clearOpen = false;
	let errorMessage = "";
	let streamState: "idle" | "connecting" | "connected" | "reconnecting" = "idle";
	let runStartedAt: Date | null = null;
	let currentRunId = "";
	let runStatus: "completed" | "aborted" | "maxIterations" | "failed" | "" = "";
	let runUsage: RunUsage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 };
	let runDurationMs = 0;
	let elapsedSeconds = 0;
	let cursor = 0;
	let activitySequence = 0;
	let optimisticUserText = "";
	let eventSource: EventSource | null = null;
	let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
	let reconnectAttempt = 0;
	let lastStreamSignalAt = 0;
	let lastReconcileAt = 0;
	let reconciling = false;
	let elapsedTimer: ReturnType<typeof setInterval> | null = null;
	let conversationElement: HTMLDivElement | null = null;

	async function request<T>(path: string, init?: RequestInit): Promise<T> {
		const response = await fetch(path, {
			...init,
			headers: {
				accept: "application/json",
				...(init?.body ? { "content-type": "application/json" } : {}),
				...init?.headers,
			},
		});
		if (!response.ok) {
			let body: ApiError = {};
			try {
				body = (await response.json()) as ApiError;
			} catch {
				/* use status fallback */
			}
			throw new Error(body.error?.message ?? body.message ?? `${response.status} ${response.statusText}`);
		}
		return (response.status === 204 ? undefined : await response.json()) as T;
	}

	const load = async () => {
		loading = true;
		errorMessage = "";
		try {
			const [blueprintData, sessionData] = await Promise.all([
				request<Blueprint[]>("/api/v1/blueprints"),
				request<SessionSummary[]>("/api/v1/sessions?limit=100"),
			]);
			blueprints = blueprintData;
			sessions = sessionData;
			const params = new URLSearchParams(window.location.search);
			const requestedSession = params.get("session");
			const requestedBlueprint = params.get("blueprint");
			if (requestedSession) {
				await openSession(requestedSession);
			} else {
				selectedBlueprintId = blueprintData.some((item) => item.id === requestedBlueprint)
					? requestedBlueprint!
					: (blueprintData[0]?.id ?? "");
			}
		} catch (error) {
			errorMessage = error instanceof Error ? error.message : "The Playground could not be loaded.";
		} finally {
			loading = false;
		}
	};

	const createSession = async () => {
		if (!selectedBlueprintId) return;
		creating = true;
		errorMessage = "";
		try {
			const created = await request<{ sessionId: string }>("/api/v1/sessions", {
				method: "POST",
				body: JSON.stringify({ blueprintId: selectedBlueprintId }),
			});
			const now = new Date().toISOString();
			sessions = [{ sessionId: created.sessionId, blueprintId: selectedBlueprintId, createdAt: now, updatedAt: now }, ...sessions];
			await openSession(created.sessionId);
		} catch (error) {
			errorMessage = error instanceof Error ? error.message : "A session could not be created.";
		} finally {
			creating = false;
		}
	};

	const openSession = async (sessionId: string) => {
		closeStream();
		stopElapsedTimer();
		errorMessage = "";
		streamingText = "";
		reasoningText = "";
		reasoningCollapsed = false;
		activities = [];
		permissions = [];
		running = false;
		runStartedAt = null;
		currentRunId = "";
		runStatus = "";
		runUsage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 };
		runDurationMs = 0;
		elapsedSeconds = 0;
		activitySequence = 0;
		try {
			const snapshot = await request<SessionSnapshot>(`/api/v1/sessions/${encodeURIComponent(sessionId)}`);
			currentSession = snapshot.session;
			selectedBlueprintId = snapshot.session.blueprintId;
			messages = snapshot.messages;
			activitySequence = Number.isFinite(snapshot.activityCount) ? snapshot.activityCount : snapshot.recentActivities.length;
			const firstActivitySequence = activitySequence - snapshot.recentActivities.length + 1;
			activities = snapshot.recentActivities.map((activity, index) => ({
				...activity,
				cursor: firstActivitySequence + index,
				receivedAt: new Date(activity.receivedAt),
			}));
			cursor = snapshot.eventCursor;
			if (snapshot.latestRun) {
				currentRunId = snapshot.latestRun.runId;
				runStatus = snapshot.latestRun.status === "running" ? "" : snapshot.latestRun.status;
				runUsage = snapshot.latestRun.usage;
				runDurationMs = snapshot.latestRun.durationMs ?? 0;
				runStartedAt = new Date(snapshot.latestRun.startedAt);
				elapsedSeconds = snapshot.latestRun.durationMs === null
					? Math.max(0, Math.floor((Date.now() - runStartedAt.getTime()) / 1000))
					: Math.max(0, Math.round(snapshot.latestRun.durationMs / 1000));
			}
			permissions = await request<Permission[]>(`/api/v1/sessions/${encodeURIComponent(sessionId)}/permissions`);
			running = snapshot.isRunning || permissions.length > 0;
			if (running) startElapsedTimer();
			window.history.replaceState({}, "", `/playground?session=${encodeURIComponent(sessionId)}`);
			connectStream();
			await scrollConversation();
		} catch (error) {
			currentSession = null;
			messages = [];
			errorMessage = error instanceof Error ? error.message : "The session could not be opened.";
		}
	};

	const connectStream = () => {
		if (!currentSession) return;
		if (reconnectTimer) clearTimeout(reconnectTimer);
		reconnectTimer = null;
		eventSource?.close();
		eventSource = null;
		streamState = "connecting";
		const source = new EventSource(`/api/v1/sessions/${encodeURIComponent(currentSession.sessionId)}/events?from=${cursor}`);
		eventSource = source;
		const consumeServerEvent = (messageEvent: MessageEvent<string>) => {
			lastStreamSignalAt = Date.now();
			if (typeof messageEvent.data !== "string" || !messageEvent.data.trim()) return;
			try {
				const event = JSON.parse(messageEvent.data) as GatewayEvent;
				const eventCursor = Number(messageEvent.lastEventId);
				if (Number.isFinite(eventCursor)) cursor = Math.max(cursor, eventCursor + 1);
				handleEvent(event);
			} catch {
				errorMessage = "A malformed event was received from the session stream.";
			}
		};
		source.onopen = () => {
			reconnectAttempt = 0;
			lastStreamSignalAt = Date.now();
			streamState = "connected";
		};
		source.addEventListener("heartbeat", () => {
			if (eventSource === source) lastStreamSignalAt = Date.now();
		});
		source.onerror = (event) => {
			// Nox uses a named SSE `error` event for agent failures. EventSource
			// also dispatches a native `error` Event during reconnects; only the
			// former is a MessageEvent with JSON data.
			if (event instanceof MessageEvent) {
				consumeServerEvent(event as MessageEvent<string>);
				return;
			}
			if (eventSource === source) {
				source.close();
				eventSource = null;
				streamState = "reconnecting";
				const delay = Math.min(500 * (2 ** reconnectAttempt), 5_000);
				reconnectAttempt += 1;
				reconnectTimer = setTimeout(() => {
					reconnectTimer = null;
					connectStream();
				}, delay);
			}
		};
		for (const eventType of ["assistantTextFragment", "assistantReasoningFragment", "message", "permissionRequest", "permissionResolved", "runStarted", "runCompleted"]) {
			source.addEventListener(eventType, (rawEvent) => {
				if (rawEvent instanceof MessageEvent) consumeServerEvent(rawEvent as MessageEvent<string>);
			});
		}
	};

	const handleEvent = (event: GatewayEvent) => {
		if (event.type !== "assistantTextFragment" && event.type !== "assistantReasoningFragment") {
			activitySequence += 1;
			activities = [...activities.slice(-49), { cursor: activitySequence, event, receivedAt: new Date() }];
		}
		if (event.type === "runStarted") {
			currentRunId = event.runId;
			runStatus = "";
			runDurationMs = 0;
			runStartedAt = new Date(event.startedAt);
			elapsedSeconds = 0;
			reasoningText = "";
			reasoningCollapsed = false;
			running = true;
			startElapsedTimer();
			return;
		}
		if (event.type === "runCompleted") {
			currentRunId = event.runId;
			runStatus = event.status;
			runUsage = event.usage;
			runDurationMs = event.durationMs;
			elapsedSeconds = Math.max(0, Math.round(event.durationMs / 1000));
			running = false;
			sending = false;
			streamingText = "";
			reasoningCollapsed = true;
			stopElapsedTimer();
			return;
		}
		if (event.type === "assistantTextFragment") {
			if (reasoningText) reasoningCollapsed = true;
			streamingText += event.text;
			running = true;
			void scrollConversation();
			return;
		}
		if (event.type === "assistantReasoningFragment") {
			reasoningText += event.text;
			running = true;
			void scrollConversation();
			return;
		}
		if (event.type === "message") {
			if (event.message.role === "user" && optimisticUserText && textContent(event.message) === optimisticUserText) {
				optimisticUserText = "";
			} else {
				messages = [...messages, event.message];
			}
			if (event.message.role === "reasoning") {
				reasoningText = "";
				reasoningCollapsed = false;
			}
			if (event.message.role === "assistant") {
				streamingText = "";
			}
			void scrollConversation();
			return;
		}
		if (event.type === "permissionRequest") {
			permissions = [...permissions.filter((item) => item.requestId !== event.requestId), event];
			running = true;
			return;
		}
		if (event.type === "permissionResolved") {
			permissions = permissions.filter((item) => item.requestId !== event.requestId);
			return;
		}
		if (event.type === "error") {
			errorMessage = event.message;
			running = false;
			sending = false;
			streamingText = "";
			reasoningCollapsed = true;
			stopElapsedTimer();
		}
	};

	const send = async () => {
		const text = prompt.trim();
		if (!text || !currentSession || sending) return;
		prompt = "";
		errorMessage = "";
		sending = true;
		running = true;
		runStartedAt = new Date();
		currentRunId = "";
		reasoningText = "";
		reasoningCollapsed = false;
		runStatus = "";
		runDurationMs = 0;
		elapsedSeconds = 0;
		startElapsedTimer();
		optimisticUserText = text;
		messages = [...messages, { role: "user", content: [{ type: "text", text }] }];
		await scrollConversation();
		try {
			await request<{ delivery: "queued" | "steered" }>(`/api/v1/sessions/${encodeURIComponent(currentSession.sessionId)}/messages`, {
				method: "POST",
				body: JSON.stringify({ text }),
			});
		} catch (error) {
			messages = messages.slice(0, -1);
			optimisticUserText = "";
			running = false;
			sending = false;
			stopElapsedTimer();
			errorMessage = error instanceof Error ? error.message : "The message could not be sent.";
		}
	};

	const abortRun = async () => {
		if (!currentSession || aborting) return;
		aborting = true;
		try {
			await request<{ aborted: boolean }>(`/api/v1/sessions/${encodeURIComponent(currentSession.sessionId)}/abort`, { method: "POST" });
			running = false;
			sending = false;
			streamingText = "";
			stopElapsedTimer();
		} catch (error) {
			errorMessage = error instanceof Error ? error.message : "The run could not be stopped.";
		} finally {
			aborting = false;
		}
	};

	const resolvePermission = async (permission: Permission, approved: boolean) => {
		if (!currentSession) return;
		try {
			await request<{ resolved: boolean }>(`/api/v1/sessions/${encodeURIComponent(currentSession.sessionId)}/permissions/${encodeURIComponent(permission.requestId)}`, {
				method: "POST",
				body: JSON.stringify({ approved }),
			});
			permissions = permissions.filter((item) => item.requestId !== permission.requestId);
		} catch (error) {
			errorMessage = error instanceof Error ? error.message : "The permission decision could not be sent.";
		}
	};

	const clearSession = async () => {
		if (!currentSession || clearing) return;
		clearing = true;
		const blueprintId = currentSession.blueprintId;
		const previousSessionId = currentSession.sessionId;
		try {
			closeStream();
			await request<void>(`/api/v1/sessions/${encodeURIComponent(previousSessionId)}`, { method: "DELETE" });
			sessions = sessions.filter((item) => item.sessionId !== previousSessionId);
			currentSession = null;
			messages = [];
			selectedBlueprintId = blueprintId;
			clearOpen = false;
			await createSession();
		} catch (error) {
			errorMessage = error instanceof Error ? error.message : "The session could not be cleared.";
			clearOpen = false;
		} finally {
			clearing = false;
		}
	};

	const selectBlueprint = (id: string) => {
		selectedBlueprintId = id;
		if (!currentSession || currentSession.blueprintId !== id) {
			currentSession = null;
			messages = [];
			permissions = [];
			activities = [];
			closeStream();
			window.history.replaceState({}, "", `/playground?blueprint=${encodeURIComponent(id)}`);
		}
	};

	const closeStream = () => {
		if (reconnectTimer) clearTimeout(reconnectTimer);
		reconnectTimer = null;
		reconnectAttempt = 0;
		eventSource?.close();
		eventSource = null;
		streamState = "idle";
	};
	const reconcileActiveRun = async () => {
		if (!currentSession || !running || reconciling) return;
		const sessionId = currentSession.sessionId;
		reconciling = true;
		try {
			const snapshot = await request<SessionSnapshot>(`/api/v1/sessions/${encodeURIComponent(sessionId)}`);
			if (currentSession?.sessionId !== sessionId) return;
			const latestRun = snapshot.latestRun;
			if (!latestRun) return;
			if (currentRunId && latestRun.runId !== currentRunId) return;
			if (!currentRunId) {
				const expectedAfter = (runStartedAt?.getTime() ?? Date.now()) - 1_000;
				if (new Date(latestRun.startedAt).getTime() < expectedAfter) return;
				currentRunId = latestRun.runId;
			}
			if (latestRun.status === "running") return;

			messages = snapshot.messages;
			activitySequence = Number.isFinite(snapshot.activityCount) ? snapshot.activityCount : snapshot.recentActivities.length;
			const firstActivitySequence = activitySequence - snapshot.recentActivities.length + 1;
			activities = snapshot.recentActivities.map((activity, index) => ({
				...activity,
				cursor: firstActivitySequence + index,
				receivedAt: new Date(activity.receivedAt),
			}));
			runStatus = latestRun.status;
			runUsage = latestRun.usage;
			runDurationMs = latestRun.durationMs ?? 0;
			elapsedSeconds = Math.max(0, Math.round(runDurationMs / 1000));
			running = false;
			sending = false;
			streamingText = "";
			reasoningText = "";
			reasoningCollapsed = true;
			stopElapsedTimer();
		} catch {
			// SSE remains the primary transport; reconciliation retries quietly.
		} finally {
			reconciling = false;
		}
	};
	const startElapsedTimer = () => {
		stopElapsedTimer();
		elapsedTimer = setInterval(() => {
			const now = Date.now();
			if (runStartedAt) elapsedSeconds = Math.floor((now - runStartedAt.getTime()) / 1000);
			if (running && now - lastReconcileAt >= 5_000) {
				lastReconcileAt = now;
				void reconcileActiveRun();
			}
			if (eventSource && streamState === "connected" && now - lastStreamSignalAt >= 40_000) {
				const stalledSource = eventSource;
				stalledSource.close();
				eventSource = null;
				streamState = "reconnecting";
				reconnectTimer = setTimeout(() => {
					reconnectTimer = null;
					connectStream();
				}, 500);
			}
		}, 1000);
	};
	const stopElapsedTimer = () => {
		if (elapsedTimer) clearInterval(elapsedTimer);
		elapsedTimer = null;
	};
	const scrollConversation = async () => {
		await tick();
		conversationElement?.scrollTo({ top: conversationElement.scrollHeight, behavior: "smooth" });
	};
	const textContent = (message: Extract<Message, { role: "user" | "assistant" | "reasoning" }>) =>
		message.content.filter((item): item is Extract<Content, { type: "text" }> => item.type === "text").map((item) => item.text).join("\n");
	const responseText = (message: Extract<Message, { role: "toolResponse" }>) =>
		message.response.filter((item): item is Extract<Content, { type: "text" }> => item.type === "text").map((item) => item.text).join("\n");
	const shortId = (value: string) => value.length > 14 ? `${value.slice(0, 9)}…${value.slice(-3)}` : value;
	const formatTime = (value: string | number) => {
		const raw = typeof value === "number" && value < 10_000_000_000 ? value * 1000 : value;
		const date = new Date(raw);
		return Number.isNaN(date.getTime()) ? "Unknown" : new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }).format(date);
	};
	const activityLabel = (activity: Activity) => {
		const event = activity.event;
		if (event.type === "error") return event.message;
		if (event.type === "runStarted") return `Run started · ${event.modelId}`;
		if (event.type === "runCompleted") return `Run ${event.status} · ${Math.round(event.durationMs)} ms`;
		if (event.type === "permissionRequest") return `Permission requested · ${event.toolName}`;
		if (event.type === "permissionResolved") return `Permission ${event.resolution}`;
		if (event.message.role === "toolCall") return `Called ${event.message.name}`;
		if (event.message.role === "toolResponse") return `${event.message.name} ${event.message.isError ? "failed" : "returned"}`;
		if (event.message.role === "user") return "User message accepted";
		if (event.message.role === "reasoning") return "Reasoning completed";
		return "Assistant response completed";
	};

	$: selectedBlueprint = blueprints.find((item) => item.id === selectedBlueprintId);
	$: blueprintSessions = sessions.filter((item) => item.blueprintId === selectedBlueprintId);
	$: toolCallCount = messages.filter((message) => message.role === "toolCall").length;
	$: assistantCount = messages.filter((message) => message.role === "assistant").length;

	onMount(load);
	onDestroy(() => {
		closeStream();
		stopElapsedTimer();
	});
</script>

<section class="playground-page">
	<header class="playground-topline">
		<div class="playground-title"><span class="eyebrow">Operate</span><h1>Playground</h1></div>
		<div class="playground-controls">
			<label><span>Blueprint</span><select value={selectedBlueprintId} onchange={(event) => selectBlueprint(event.currentTarget.value)} disabled={loading || running}><option value="">Select blueprint…</option>{#each blueprints as blueprint}<option value={blueprint.id}>{blueprint.id}</option>{/each}</select></label>
			<label><span>Session</span><select value={currentSession?.sessionId ?? ""} onchange={(event) => event.currentTarget.value && openSession(event.currentTarget.value)} disabled={!selectedBlueprintId || running}><option value="">New scratch session</option>{#each blueprintSessions as session}<option value={session.sessionId}>{shortId(session.sessionId)} · {formatTime(session.updatedAt)}</option>{/each}</select></label>
			<button class="button secondary" type="button" onclick={createSession} disabled={!selectedBlueprintId || creating || running}>{creating ? "Starting…" : "+ New session"}</button>
			<button class="button secondary" type="button" onclick={() => (clearOpen = true)} disabled={!currentSession || running}>Clear</button>
		</div>
	</header>

	{#if errorMessage}<div class="playground-notice" role="alert"><span>!</span><p>{errorMessage}</p><button type="button" aria-label="Dismiss error" onclick={() => (errorMessage = "")}>×</button></div>{/if}

	{#if loading}
		<div class="playground-loading"><span class="table-skeleton long"></span><span class="table-skeleton"></span><span class="table-skeleton short"></span></div>
	{:else if blueprints.length === 0}
		<div class="playground-setup-empty"><div class="playground-empty-mark"><span>›_</span></div><span class="panel-kicker">A runnable definition is required</span><h2>Create a blueprint first</h2><p>The Playground starts isolated sessions from a saved blueprint and its configured provider.</p><a class="button primary" href="/blueprints/new">Create blueprint</a></div>
	{:else}
		<div class="playground-shell">
			<aside class="playground-session-panel">
				<div class="playground-panel-head"><span class="panel-kicker">Session</span><h2>{currentSession ? "Scratch workspace" : "Ready to start"}</h2></div>
				{#if selectedBlueprint}
					<div class="playground-blueprint-card"><Avatar kind="blueprint" seed={`blueprint:${selectedBlueprint.id}`} label={selectedBlueprint.id} size={32} /><div><strong>{selectedBlueprint.id}</strong><span>{selectedBlueprint.description}</span></div></div>
					<div class="playground-facts">
						<div><span>Provider</span><strong>{selectedBlueprint.config.providerId}</strong></div><div><span>Model</span><strong>{selectedBlueprint.config.modelId}</strong></div><div><span>Tools</span><strong>{selectedBlueprint.coreTools.length + selectedBlueprint.lazyLoadedTools.length}</strong></div><div><span>Turn limit</span><strong>{selectedBlueprint.config.maxIterations}</strong></div>
					</div>
				{/if}
				<div class="session-history-heading"><span>Saved sessions</span><strong>{blueprintSessions.length}</strong></div>
				<div class="playground-session-list">
					{#each blueprintSessions.slice(0, 8) as session}<button class:active={currentSession?.sessionId === session.sessionId} type="button" onclick={() => openSession(session.sessionId)} disabled={running}><span class="session-pulse"></span><div><strong>{shortId(session.sessionId)}</strong><small>{formatTime(session.updatedAt)}</small></div></button>{:else}<div class="session-list-empty">No saved sessions for this blueprint.</div>{/each}
				</div>
			</aside>

			<main class="playground-conversation">
				<header class="conversation-head"><div><span class:live={running} class="conversation-state"><i></i>{running ? permissions.length ? "Waiting for permission" : "Responding" : currentSession ? "Ready" : "No session"}</span>{#if currentSession}<code>{shortId(currentSession.sessionId)}</code>{/if}</div>{#if running}<button class="stop-run" type="button" onclick={abortRun} disabled={aborting}><span></span>{aborting ? "Stopping…" : "Stop run"}</button>{/if}</header>
				<div class="conversation-scroll" bind:this={conversationElement}>
					{#if !currentSession}
						<div class="conversation-empty"><div class="conversation-empty-orbit"><span></span></div><h2>Start a scratch session</h2><p>Test <strong>{selectedBlueprint?.id}</strong> in an isolated, locally stored conversation.</p><button class="button primary" type="button" onclick={createSession} disabled={creating}>{creating ? "Starting…" : "Start session"}</button></div>
					{:else if messages.length === 0 && !streamingText}
						<div class="conversation-empty"><div class="conversation-empty-orbit ready"><span></span></div><span class="panel-kicker">Session ready</span><h2>What should {selectedBlueprint?.id} work on?</h2><p>Messages and tool activity will appear here as they happen.</p></div>
					{:else}
						<div class="message-stack">
							{#each messages as message, messageIndex}
								{#if message.role === "reasoning"}
									{@const response = messages[messageIndex + 1]}
									<article class="chat-message assistant"><div class="message-author"><Avatar kind="blueprint" seed={`blueprint:${selectedBlueprint?.id ?? "unknown"}`} size={28} decorative /><strong>{selectedBlueprint?.id}</strong></div><div class="message-body"><details class="reasoning-block completed"><summary><span>Reasoning</span><small>Show</small></summary><div><Markdown source={textContent(message)} /></div></details>{#if response?.role === "assistant"}<Markdown source={textContent(response)} />{#each response.content.filter((item) => item.type === "image") as image}<img src={image.source.kind === "url" ? image.source.url : `data:${image.source.mediaType};base64,${image.source.data}`} alt="Message attachment" />{/each}{/if}</div></article>
								{:else if message.role === "assistant" && messages[messageIndex - 1]?.role === "reasoning"}
									<!-- Rendered together with the preceding reasoning message. -->
								{:else if message.role === "user" || message.role === "assistant"}
									<article class:assistant={message.role === "assistant"} class="chat-message"><div class="message-author"><Avatar kind={message.role === "user" ? "user" : "blueprint"} seed={message.role === "user" ? "nox-local-user" : `blueprint:${selectedBlueprint?.id ?? "unknown"}`} size={28} decorative /><strong>{message.role === "user" ? "You" : selectedBlueprint?.id}</strong></div><div class="message-body"><Markdown source={textContent(message)} />{#each message.content.filter((item) => item.type === "image") as image}<img src={image.source.kind === "url" ? image.source.url : `data:${image.source.mediaType};base64,${image.source.data}`} alt="Message attachment" />{/each}</div></article>
								{:else if message.role === "toolCall"}
									<article class="tool-event call"><div class="tool-event-icon">⌘</div><div><span>Tool call</span><strong>{message.name}</strong><pre>{JSON.stringify(message.arguments, null, 2)}</pre></div></article>
								{:else}
									<article class:error={message.isError} class="tool-event response"><div class="tool-event-icon">{message.isError ? "!" : "✓"}</div><div><span>{message.execution === "deferredAck" ? "Deferred tool accepted" : message.execution === "deferredResult" ? "Deferred result" : "Tool response"}</span><strong>{message.name}</strong><pre>{responseText(message) || "No textual output"}</pre></div></article>
								{/if}
							{/each}
							{#if streamingText || reasoningText}<article class="chat-message assistant streaming"><div class="message-author"><Avatar kind="blueprint" seed={`blueprint:${selectedBlueprint?.id ?? "unknown"}`} size={28} decorative /><strong>{selectedBlueprint?.id}</strong><i></i></div><div class="message-body">{#if reasoningText}<details class="reasoning-block live" open={!reasoningCollapsed}><summary><span>Reasoning</span><small>{reasoningCollapsed ? "Show" : "Thinking…"}</small></summary><div><Markdown source={reasoningText} /></div></details>{/if}{#if streamingText}<Markdown source={streamingText} /><span class="stream-caret"></span>{/if}</div></article>{/if}
						</div>
					{/if}
				</div>

				{#if permissions.length > 0}
					<div class="permission-dock">
						{#each permissions as permission}<div class="permission-copy"><span class="permission-shield">!</span><div><span>Permission required</span><strong>{permission.toolName}</strong><p>{permission.reason}</p><details><summary>View arguments</summary><pre>{JSON.stringify(permission.toolArguments, null, 2)}</pre></details></div></div><div class="permission-actions"><button class="button secondary" type="button" onclick={() => resolvePermission(permission, false)}>Deny</button><button class="button primary" type="button" onclick={() => resolvePermission(permission, true)}>Allow once</button></div>{/each}
					</div>
				{/if}

				<div class="composer-wrap">
					<label class="composer" class:disabled={!currentSession}><span class="visually-hidden">Message {selectedBlueprint?.id ?? "blueprint"}</span><textarea bind:value={prompt} disabled={!currentSession || sending} rows="2" placeholder={currentSession ? `Message ${selectedBlueprint?.id}…` : "Start a session to send a message"} onkeydown={(event) => { if (event.key === "Enter" && !event.shiftKey && !event.isComposing) { event.preventDefault(); send(); } }}></textarea><div class="composer-footer"><span>{running ? "A run is active" : "Enter to send · Shift+Enter for a new line"}</span><button type="button" onclick={send} disabled={!currentSession || !prompt.trim() || sending}><span aria-hidden="true">↑</span>{sending ? "Queued" : "Send"}</button></div></label>
				</div>
			</main>

			<aside class="playground-inspector">
				<div class="playground-panel-head inspector-head"><span class="panel-kicker">Inspector</span><h2>Current run</h2></div>
				<div class="run-status-card"><div class="run-status-main"><span class:active={running} class="run-status-dot"></span><div><strong>{running ? permissions.length ? "Permission required" : "Agent responding" : runStatus ? `Run ${runStatus}` : currentSession ? "Session idle" : "Not started"}</strong><span>{running ? `${elapsedSeconds}s elapsed` : runDurationMs ? `${Math.round(runDurationMs)} ms · ${streamState === "connected" ? "stream connected" : "stream offline"}` : streamState === "connected" ? "Event stream connected" : "No active event stream"}</span></div></div>{#if currentRunId}<code>Run {shortId(currentRunId)}</code>{:else if currentSession}<code>Session {shortId(currentSession.sessionId)}</code>{/if}</div>
				<div class="run-facts"><div><span>Messages</span><strong>{messages.length}</strong></div><div><span>Responses</span><strong>{assistantCount}</strong></div><div><span>Tool calls</span><strong>{toolCallCount}</strong></div></div>
				<div class="run-usage"><div class="run-usage-head"><span>Last measured usage</span><strong>{runUsage.inputTokens + runUsage.outputTokens} tokens</strong></div><div><span>Input</span><strong>{runUsage.inputTokens.toLocaleString()}</strong></div><div><span>Output</span><strong>{runUsage.outputTokens.toLocaleString()}</strong></div><div><span>Cache read</span><strong>{runUsage.cacheReadTokens.toLocaleString()}</strong></div></div>
				{#if permissions.length > 0}<div class="inspector-attention"><span>!</span><div><strong>Run paused</strong><p>A protected tool is waiting for your decision.</p></div></div>{/if}
				<div class="activity-heading"><span>Live activity</span></div>
				<div class="activity-timeline">
					{#each activities.slice(-8).reverse() as activity}<div class:error={activity.event.type === "error"} class="activity-item"><span></span><div><strong>{activityLabel(activity)}</strong><small>{activity.receivedAt.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })} · #{activity.cursor}</small></div></div>{:else}<div class="activity-empty"><span>···</span><p>Run events will appear here.</p></div>{/each}
				</div>
				<div class="inspector-contract"><strong>Run-local measurements</strong><p>Usage reflects provider-reported tokens for the latest completed run. Cost estimation is not configured.</p></div>
			</aside>
		</div>
	{/if}

	{#if clearOpen}<div class="dialog-backdrop" role="presentation" onclick={(event) => { if (event.target === event.currentTarget) clearOpen = false; }}><div class="confirm-dialog" role="dialog" aria-modal="true" aria-labelledby="clear-session-title"><div class="dialog-danger-mark reset-mark">↻</div><h2 id="clear-session-title">Clear this session?</h2><p>The stored conversation will be deleted and replaced with a fresh session using the same blueprint.</p><div class="dialog-actions"><button class="button secondary" type="button" onclick={() => (clearOpen = false)}>Cancel</button><button class="button danger" type="button" onclick={clearSession} disabled={clearing}>{clearing ? "Clearing…" : "Clear session"}</button></div></div></div>{/if}
</section>

<style>
	/*
	 * The playground is a fixed-height, three-column app view rather than a
	 * scrolling document: session list | conversation | run inspector.
	 *
	 * It reads --playground-gutter, which AppLayout sets on .app-content when
	 * the playground-content modifier is applied.
	 */

	.playground-page {
		display: flex;
		/* dvh repeats the vh line so mobile browsers with a collapsing URL bar
		   get the dynamic value while older engines keep the static one. */
		height: calc(100vh - var(--topbar-height) - var(--playground-gutter) - var(--playground-gutter));
		height: calc(100dvh - var(--topbar-height) - var(--playground-gutter) - var(--playground-gutter));
		min-height: 0;
		overflow: hidden;
		flex-direction: column;
		background: rgb(12 15 13 / 72%);
		border: 1px solid var(--border);
		border-radius: 8px;
	}

	/* --------------------------------------------------------- top controls */

	.playground-topline {
		display: flex;
		min-height: 74px;
		align-items: center;
		justify-content: space-between;
		gap: 22px;
		padding: 12px 22px;
		background: rgb(14 18 15 / 87%);
		border-bottom: 1px solid var(--border);
		backdrop-filter: blur(15px);
	}
	.playground-title {
		display: flex;
		flex: 0 0 auto;
		align-items: baseline;
		gap: 9px;
	}
	.playground-title h1 {
		margin: 0;
		font-size: 18px;
		font-weight: 580;
		letter-spacing: -.02em;
	}
	.playground-controls {
		display: flex;
		min-width: 0;
		align-items: center;
		justify-content: flex-end;
		gap: 8px;
	}
	/* The label is the visible control shell; the select inside is chromeless. */
	.playground-controls label {
		display: flex;
		height: 34px;
		align-items: center;
		gap: 7px;
		padding-left: 9px;
		background: var(--surface-1);
		border: 1px solid var(--border);
		border-radius: 6px;
		color: var(--muted);
		font-size: 9px;
	}
	.playground-controls select {
		width: 148px;
		height: 32px;
		padding: 0 24px 0 0;
		background: transparent;
		border: 0;
		outline: 0;
		color: var(--text);
		font-size: 10px;
	}
	/* Model IDs are longer and monospaced. */
	.playground-controls label:nth-child(2) select {
		width: 190px;
		font-family: var(--font-mono);
		font-size: 9px;
	}

	.playground-notice {
		display: grid;
		grid-template-columns: 20px minmax(0, 1fr) 24px;
		align-items: center;
		gap: 8px;
		margin: 10px 14px 0;
		padding: 8px 10px;
		background: var(--danger-soft);
		border: 1px solid rgb(216 120 114 / 18%);
		border-radius: 6px;
		color: #dd928d;
	}
	.playground-notice > span {
		display: grid;
		width: 18px;
		height: 18px;
		place-items: center;
		border: 1px solid rgb(216 120 114 / 30%);
		border-radius: 50%;
		font-size: 9px;
		font-weight: 700;
	}
	.playground-notice p {
		margin: 0;
		font-size: 10px;
	}
	.playground-notice button {
		width: 24px;
		height: 24px;
		padding: 0;
		background: transparent;
		border: 0;
		color: var(--muted);
		cursor: pointer;
		font-size: 16px;
	}

	/* -------------------------------------------------------- first-run states */

	.playground-loading {
		display: flex;
		min-height: 0;
		flex: 1;
		justify-content: center;
		flex-direction: column;
		gap: 24px;
		padding: 15%;
	}
	.playground-setup-empty {
		display: flex;
		min-height: 0;
		flex: 1;
		align-items: center;
		justify-content: center;
		flex-direction: column;
		padding: 30px;
		text-align: center;
	}
	.playground-setup-empty h2 {
		margin: 5px 0 0;
		font-size: 20px;
		font-weight: 570;
	}
	.playground-setup-empty p {
		max-width: 390px;
		margin: 7px 0 18px;
		color: var(--muted);
		font-size: 11px;
	}
	.playground-empty-mark {
		display: grid;
		width: 52px;
		height: 52px;
		place-items: center;
		margin-bottom: 20px;
		background: var(--surface-2);
		border: 1px solid var(--border);
		border-radius: 12px;
		box-shadow: 0 12px 35px rgb(0 0 0 / 18%);
		color: var(--accent);
		font-family: var(--font-mono);
		font-size: 15px;
	}

	/* ---------------------------------------------------------- three-column */

	.playground-shell {
		display: grid;
		min-height: 0;
		flex: 1 1 auto;
		grid-template-columns: 218px minmax(430px, 1fr) 264px;
		overflow: hidden;
		background: rgb(12 15 13 / 72%);
	}
	.playground-session-panel,
	.playground-inspector {
		min-width: 0;
		background: rgb(16 20 17 / 90%);
	}
	.playground-session-panel {
		overflow-y: auto;
		border-right: 1px solid var(--border);
	}
	.playground-inspector {
		overflow-y: auto;
		border-left: 1px solid var(--border);
	}
	.playground-panel-head {
		min-height: 66px;
		padding: 16px;
		border-bottom: 1px solid var(--border);
	}
	.playground-panel-head h2 {
		margin: 3px 0 0;
		font-size: 13px;
		font-weight: 580;
	}

	/* ------------------------------------------------------------ session list */

	.playground-blueprint-card {
		display: flex;
		align-items: center;
		gap: 10px;
		padding: 14px 15px;
		border-bottom: 1px solid var(--border);
	}
	.playground-blueprint-card > div { min-width: 0; }
	.playground-blueprint-card strong,
	.playground-blueprint-card span { display: block; }
	.playground-blueprint-card strong {
		overflow: hidden;
		font-size: 11px;
		font-weight: 580;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.playground-blueprint-card div span {
		margin-top: 2px;
		overflow: hidden;
		color: var(--muted);
		font-size: 8px;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.playground-facts {
		display: grid;
		grid-template-columns: repeat(2, minmax(0, 1fr));
		padding: 8px 15px 13px;
		border-bottom: 1px solid var(--border);
	}
	.playground-facts > div {
		min-width: 0;
		padding: 7px 0;
	}
	.playground-facts span,
	.playground-facts strong { display: block; }
	.playground-facts span {
		color: var(--muted);
		font-size: 8px;
	}
	.playground-facts strong {
		margin-top: 2px;
		overflow: hidden;
		font-family: var(--font-mono);
		font-size: 9px;
		font-weight: 550;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.session-history-heading,
	.activity-heading {
		display: flex;
		min-height: 38px;
		align-items: center;
		justify-content: space-between;
		padding: 0 15px;
		color: var(--muted);
		font-size: 8px;
		font-weight: 650;
		letter-spacing: .07em;
		text-transform: uppercase;
	}
	.playground-session-list { padding: 0 8px 12px; }
	.playground-session-list button {
		display: grid;
		grid-template-columns: 7px minmax(0, 1fr);
		width: 100%;
		min-height: 45px;
		align-items: center;
		gap: 8px;
		padding: 7px 8px;
		background: transparent;
		border: 1px solid transparent;
		border-radius: 6px;
		color: var(--secondary);
		cursor: pointer;
		text-align: left;
	}
	.playground-session-list button:hover { background: var(--surface-2); }
	.playground-session-list button.active {
		background: var(--accent-soft);
		border-color: rgb(208 164 92 / 12%);
		color: #e4c687;
	}
	.session-pulse {
		width: 5px;
		height: 5px;
		background: var(--muted);
		border-radius: 50%;
	}
	.playground-session-list button.active .session-pulse {
		background: var(--accent);
		box-shadow: 0 0 0 3px rgb(208 164 92 / 10%);
	}
	.playground-session-list strong,
	.playground-session-list small {
		display: block;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.playground-session-list strong {
		font-family: var(--font-mono);
		font-size: 9px;
		font-weight: 550;
	}
	.playground-session-list small {
		margin-top: 2px;
		color: var(--muted);
		font-size: 8px;
	}
	.session-list-empty {
		padding: 15px 8px;
		color: var(--muted);
		font-size: 9px;
		text-align: center;
	}

	/* ------------------------------------------------------------ conversation */

	/* Rows: header | scrolling transcript | permission dock | composer. */
	.playground-conversation {
		display: grid;
		width: 100%;
		height: 100%;
		min-width: 0;
		min-height: 0;
		max-height: 100%;
		overflow: hidden;
		grid-template-rows: 53px minmax(0, 1fr) auto auto;
		background: rgb(12 15 13 / 78%);
	}
	.conversation-head {
		display: flex;
		height: 53px;
		align-items: center;
		justify-content: space-between;
		padding: 0 18px;
		border-bottom: 1px solid var(--border);
	}
	.conversation-head > div {
		display: flex;
		min-width: 0;
		align-items: center;
		gap: 10px;
	}
	.conversation-head code {
		color: var(--muted);
		font-family: var(--font-mono);
		font-size: 8px;
	}
	.conversation-state {
		display: flex;
		align-items: center;
		gap: 6px;
		color: var(--muted);
		font-size: 9px;
		font-weight: 570;
	}
	.conversation-state i {
		display: block;
		width: 6px;
		height: 6px;
		background: var(--muted);
		border-radius: 50%;
	}
	.conversation-state.live { color: #8fc2a1; }
	.conversation-state.live i {
		background: var(--healthy);
		box-shadow: 0 0 0 3px rgb(105 180 134 / 10%);
		animation: status-pulse 1.5s ease infinite;
	}
	.stop-run {
		display: flex;
		height: 29px;
		align-items: center;
		gap: 6px;
		padding: 0 9px;
		background: var(--danger-soft);
		border: 1px solid rgb(216 120 114 / 18%);
		border-radius: 5px;
		color: var(--danger-text);
		cursor: pointer;
		font-size: 9px;
	}
	.stop-run span {
		display: block;
		width: 7px;
		height: 7px;
		background: currentColor;
		border-radius: 1px;
	}

	/* overscroll-behavior stops the page bouncing when the transcript ends;
	   scrollbar-gutter keeps the column from shifting as content grows. */
	.conversation-scroll {
		height: 100%;
		min-height: 0;
		max-height: 100%;
		overflow-x: hidden;
		overflow-y: auto;
		overscroll-behavior: contain;
		scrollbar-gutter: stable;
		scrollbar-width: thin;
		scrollbar-color: var(--surface-3) transparent;
	}
	.conversation-scroll::-webkit-scrollbar { width: 8px; }
	.conversation-scroll::-webkit-scrollbar-track { background: transparent; }
	.conversation-scroll::-webkit-scrollbar-thumb {
		background: var(--surface-3);
		border: 2px solid transparent;
		border-radius: 8px;
		background-clip: padding-box;
	}

	.conversation-empty {
		display: flex;
		min-height: 100%;
		align-items: center;
		justify-content: center;
		flex-direction: column;
		padding: 35px;
		text-align: center;
	}
	.conversation-empty h2 {
		margin: 7px 0 0;
		font-size: 17px;
		font-weight: 570;
		letter-spacing: -.02em;
	}
	.conversation-empty p {
		max-width: 340px;
		margin: 6px 0 17px;
		color: var(--muted);
		font-size: 10px;
	}
	.conversation-empty p strong {
		color: var(--secondary);
		font-weight: 570;
	}
	/* Concentric rings with a dot at the centre; turns green once ready. */
	.conversation-empty-orbit {
		position: relative;
		display: grid;
		width: 48px;
		height: 48px;
		place-items: center;
		margin-bottom: 13px;
		border: 1px solid var(--border);
		border-radius: 50%;
	}
	.conversation-empty-orbit::before,
	.conversation-empty-orbit::after {
		position: absolute;
		border: 1px solid var(--border);
		border-radius: 50%;
		content: '';
	}
	.conversation-empty-orbit::before { inset: 7px; }
	.conversation-empty-orbit::after {
		inset: 15px;
		background: var(--surface-2);
	}
	.conversation-empty-orbit span {
		z-index: 1;
		width: 5px;
		height: 5px;
		background: var(--muted);
		border-radius: 50%;
	}
	.conversation-empty-orbit.ready span {
		background: var(--healthy);
		box-shadow: 0 0 0 4px rgb(105 180 134 / 9%);
	}

	/* --------------------------------------------------------------- messages */

	.message-stack {
		width: min(760px, 100%);
		margin: 0 auto;
		padding: 30px 28px 22px;
	}
	.chat-message {
		display: grid;
		grid-template-columns: 30px minmax(0, 1fr);
		gap: 11px;
		margin-bottom: 28px;
	}
	/* display: contents lets the avatar and name drop into the parent grid.
	   The avatar itself is an <img> rendered by Avatar.svelte, which styles
	   itself — this component only positions it. */
	.message-author { display: contents; }
	.message-author strong {
		align-self: center;
		font-size: 10px;
		font-weight: 590;
	}
	.message-body {
		grid-column: 2;
		min-width: 0;
		margin-top: -4px;
		color: #d8ded9;
		font-size: 12px;
		line-height: 1.65;
		overflow-wrap: anywhere;
	}
	/* User messages get a bubble; assistant messages sit flush. */
	.chat-message:not(.assistant) .message-body {
		padding: 10px 12px;
		background: var(--surface-2);
		border: 1px solid var(--border);
		border-radius: 2px 8px 8px 8px;
	}
	/* :global because images arrive both from this template (attachments) and
	   from Markdown's {@html} output, which carries no scope class. */
	.message-body :global(img) {
		display: block;
		max-width: min(100%, 520px);
		max-height: 380px;
		margin-top: 10px;
		border: 1px solid var(--border);
		border-radius: 7px;
		object-fit: contain;
	}
	.reasoning-block {
		margin: 0 0 14px 41px;
		border-left: 1px solid rgb(154 167 158 / 24%);
		color: var(--muted);
		opacity: .68;
	}
	.message-body .reasoning-block { margin-left: 0; }
	.reasoning-block summary {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 12px;
		padding: 4px 9px;
		cursor: pointer;
		font-size: 8px;
		list-style: none;
		text-transform: uppercase;
		letter-spacing: .08em;
	}
	.reasoning-block summary::-webkit-details-marker { display: none; }
	.reasoning-block summary::before {
		content: '›';
		font-family: var(--font-mono);
		transition: transform 120ms ease;
	}
	.reasoning-block[open] summary::before { transform: rotate(90deg); }
	.reasoning-block summary span { margin-right: auto; }
	.reasoning-block summary small {
		font-size: 7px;
		font-weight: 500;
		letter-spacing: 0;
		text-transform: none;
	}
	.reasoning-block > div {
		max-height: 220px;
		overflow: auto;
		padding: 3px 9px 8px 24px;
		font-size: 10px;
		font-style: italic;
		line-height: 1.55;
	}
	.reasoning-block.live:not([open]) { margin-bottom: 8px; }

	.chat-message.streaming { position: relative; }
	.chat-message.streaming .message-author i {
		display: inline-block;
		width: 5px;
		height: 5px;
		margin-left: 5px;
		background: var(--healthy);
		border-radius: 50%;
		animation: status-pulse 1.2s ease infinite;
	}
	.stream-caret {
		display: inline-block;
		width: 5px;
		height: 12px;
		margin-left: 3px;
		background: var(--accent);
		vertical-align: -2px;
		animation: status-pulse .8s steps(1) infinite;
	}

	/* ------------------------------------------------------------ tool events */

	/* Indented to align under the message body, not the avatar. */
	.tool-event {
		display: grid;
		grid-template-columns: 28px minmax(0, 1fr);
		gap: 10px;
		margin: -6px 0 22px 39px;
		padding: 10px 11px;
		background: #101512;
		border: 1px solid var(--border);
		border-radius: 6px;
	}
	.tool-event-icon {
		display: grid;
		width: 27px;
		height: 27px;
		place-items: center;
		background: var(--healthy-soft);
		border: 1px solid rgb(105 180 134 / 14%);
		border-radius: 6px;
		color: var(--healthy);
		font-size: 9px;
	}
	.tool-event.call .tool-event-icon {
		background: var(--cloud-soft);
		border-color: rgb(118 162 206 / 14%);
		color: var(--cloud);
	}
	.tool-event.error .tool-event-icon {
		background: var(--danger-soft);
		border-color: rgb(216 120 114 / 17%);
		color: var(--danger);
	}
	.tool-event span,
	.tool-event strong { display: block; }
	.tool-event span {
		color: var(--muted);
		font-size: 8px;
	}
	.tool-event strong {
		margin-top: 1px;
		font-size: 9px;
		font-weight: 570;
	}
	.tool-event pre,
	.permission-copy pre {
		max-height: 130px;
		margin: 7px 0 0;
		padding: 7px;
		overflow: auto;
		background: var(--code-bg);
		border: 1px solid var(--border);
		border-radius: 4px;
		color: var(--secondary);
		font-family: var(--font-mono);
		font-size: 8px;
		line-height: 1.45;
		white-space: pre-wrap;
	}

	/* -------------------------------------------------------- permission dock */

	.permission-dock {
		display: flex;
		align-items: flex-end;
		justify-content: space-between;
		gap: 15px;
		margin: 0 16px 10px;
		padding: 12px;
		background: linear-gradient(110deg, #282116, #1a1711);
		border: 1px solid #4a3c25;
		border-radius: 7px;
		box-shadow: 0 12px 30px rgb(0 0 0 / 18%);
	}
	.permission-copy {
		display: flex;
		min-width: 0;
		align-items: flex-start;
		gap: 10px;
	}
	.permission-shield {
		display: grid;
		width: 28px;
		height: 28px;
		flex: 0 0 auto;
		place-items: center;
		background: var(--accent-soft);
		border: 1px solid rgb(208 164 92 / 22%);
		border-radius: 50%;
		color: var(--accent);
		font-size: 10px;
		font-weight: 700;
	}
	.permission-copy > div > span,
	.permission-copy strong { display: block; }
	.permission-copy > div > span {
		color: var(--accent);
		font-size: 8px;
		font-weight: 650;
		letter-spacing: .07em;
		text-transform: uppercase;
	}
	.permission-copy strong {
		margin-top: 2px;
		font-size: 11px;
		font-weight: 590;
	}
	.permission-copy p {
		margin: 2px 0 0;
		color: var(--muted);
		font-size: 9px;
	}
	.permission-copy details { margin-top: 6px; }
	.permission-copy summary {
		color: var(--secondary);
		cursor: pointer;
		font-size: 8px;
	}
	.permission-actions {
		display: flex;
		flex: 0 0 auto;
		gap: 7px;
	}

	/* -------------------------------------------------------------- composer */

	/* Gradient fades the transcript out behind the composer as it scrolls. */
	.composer-wrap {
		padding: 10px 16px 14px;
		background: linear-gradient(to top, var(--canvas) 80%, rgb(12 15 13 / 0%));
	}
	.composer {
		display: block;
		width: min(760px, 100%);
		margin: 0 auto;
		overflow: hidden;
		background: var(--surface-raised);
		border: 1px solid var(--border-strong);
		border-radius: 8px;
		box-shadow: 0 10px 35px rgb(0 0 0 / 16%);
		transition: border-color 120ms ease, box-shadow 120ms ease;
	}
	.composer:focus-within {
		border-color: #61563f;
		box-shadow: 0 0 0 2px rgb(208 164 92 / 7%), 0 10px 35px rgb(0 0 0 / 16%);
	}
	.composer.disabled { opacity: .55; }
	.composer textarea {
		display: block;
		width: 100%;
		min-height: 58px;
		max-height: 170px;
		padding: 11px 12px 4px;
		resize: none;
		background: transparent;
		border: 0;
		outline: 0;
		color: var(--text);
		font-size: 11px;
		line-height: 1.5;
	}
	.composer textarea::placeholder { color: #626c65; }
	.composer-footer {
		display: flex;
		min-height: 39px;
		align-items: center;
		justify-content: space-between;
		padding: 4px 6px 6px 12px;
	}
	.composer-footer > span {
		color: var(--muted);
		font-size: 8px;
	}
	.composer-footer button {
		display: flex;
		height: 29px;
		align-items: center;
		gap: 5px;
		padding: 0 10px;
		background: var(--accent);
		border: 1px solid var(--accent-border);
		border-radius: 5px;
		color: var(--on-accent);
		cursor: pointer;
		font-size: 9px;
		font-weight: 650;
	}
	.composer-footer button > span {
		display: grid;
		width: 15px;
		height: 15px;
		place-items: center;
		background: rgb(0 0 0 / 11%);
		border-radius: 4px;
		font-size: 11px;
	}
	.composer-footer button:disabled {
		cursor: default;
		opacity: .45;
	}

	/* ------------------------------------------------------------- inspector */

	.inspector-head { min-height: 66px; }

	.run-status-card {
		padding: 14px 15px;
		border-bottom: 1px solid var(--border);
	}
	.run-status-main {
		display: flex;
		align-items: center;
		gap: 9px;
	}
	.run-status-main > div { min-width: 0; }
	.run-status-dot {
		width: 8px;
		height: 8px;
		flex: 0 0 auto;
		background: var(--muted);
		border-radius: 50%;
	}
	.run-status-dot.active {
		background: var(--healthy);
		box-shadow: 0 0 0 4px rgb(105 180 134 / 9%);
		animation: status-pulse 1.5s ease infinite;
	}
	.run-status-main strong,
	.run-status-main span { display: block; }
	.run-status-main strong {
		font-size: 10px;
		font-weight: 580;
	}
	.run-status-main span {
		margin-top: 2px;
		color: var(--muted);
		font-size: 8px;
	}
	/* Aligned under the status text, past the dot. */
	.run-status-card code {
		display: block;
		margin: 11px 0 0 17px;
		padding-top: 9px;
		border-top: 1px solid var(--border);
		color: var(--muted);
		font-family: var(--font-mono);
		font-size: 8px;
	}

	.run-facts {
		display: grid;
		grid-template-columns: repeat(2, minmax(0, 1fr));
		padding: 8px 15px 13px;
		border-bottom: 1px solid var(--border);
	}
	.run-facts > div { padding: 7px 0; }
	.run-facts span,
	.run-facts strong { display: block; }
	.run-facts span {
		color: var(--muted);
		font-size: 8px;
	}
	.run-facts strong {
		margin-top: 2px;
		font-family: var(--font-mono);
		font-size: 12px;
		font-weight: 540;
	}

	.run-usage {
		display: grid;
		grid-template-columns: repeat(3, minmax(0, 1fr));
		padding: 10px 15px 13px;
		border-bottom: 1px solid var(--border);
	}
	.run-usage-head {
		display: flex;
		grid-column: 1 / -1;
		align-items: center;
		justify-content: space-between;
		margin-bottom: 8px;
		color: var(--muted);
		font-size: 8px;
	}
	.run-usage-head strong {
		color: var(--secondary);
		font-family: var(--font-mono);
		font-size: 8px;
		font-weight: 550;
	}
	.run-usage > div:not(.run-usage-head) span,
	.run-usage > div:not(.run-usage-head) strong { display: block; }
	.run-usage > div:not(.run-usage-head) span {
		color: var(--muted);
		font-size: 7px;
	}
	.run-usage > div:not(.run-usage-head) strong {
		margin-top: 2px;
		font-family: var(--font-mono);
		font-size: 9px;
		font-weight: 550;
	}

	.inspector-attention {
		display: flex;
		align-items: flex-start;
		gap: 9px;
		margin: 12px;
		padding: 10px;
		background: var(--accent-soft);
		border: 1px solid rgb(208 164 92 / 16%);
		border-radius: 6px;
	}
	.inspector-attention > span {
		display: grid;
		width: 19px;
		height: 19px;
		flex: 0 0 auto;
		place-items: center;
		border: 1px solid rgb(208 164 92 / 30%);
		border-radius: 50%;
		color: var(--accent);
		font-size: 8px;
		font-weight: 700;
	}
	.inspector-attention strong {
		font-size: 9px;
		font-weight: 580;
	}
	.inspector-attention p {
		margin: 2px 0 0;
		color: var(--muted);
		font-size: 8px;
	}

	/* ------------------------------------------------------ activity timeline */

	.activity-timeline { padding: 0 15px; }
	.activity-item {
		position: relative;
		display: grid;
		grid-template-columns: 8px minmax(0, 1fr);
		min-height: 45px;
		gap: 8px;
		padding: 7px 0;
	}
	/* Connector line running between dots; suppressed on the last item. */
	.activity-item::before {
		position: absolute;
		top: 17px;
		bottom: -9px;
		left: 3px;
		border-left: 1px solid var(--border);
		content: '';
	}
	.activity-item:last-child::before { display: none; }
	.activity-item > span {
		z-index: 1;
		width: 7px;
		height: 7px;
		margin-top: 4px;
		background: var(--healthy);
		border: 2px solid var(--surface-1);
		border-radius: 50%;
		box-shadow: 0 0 0 1px rgb(105 180 134 / 30%);
	}
	.activity-item.error > span {
		background: var(--danger);
		box-shadow: 0 0 0 1px rgb(216 120 114 / 30%);
	}
	.activity-item strong,
	.activity-item small { display: block; }
	.activity-item strong {
		overflow: hidden;
		font-size: 8px;
		font-weight: 550;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.activity-item small {
		margin-top: 2px;
		color: var(--muted);
		font-family: var(--font-mono);
		font-size: 7px;
	}
	.activity-empty {
		padding: 17px 5px;
		color: var(--muted);
		text-align: center;
	}
	.activity-empty span {
		font-family: var(--font-mono);
		font-size: 12px;
		letter-spacing: .1em;
	}
	.activity-empty p {
		margin: 3px 0 0;
		font-size: 8px;
	}

	.inspector-contract {
		margin: 16px 12px;
		padding: 10px;
		background: #131714;
		border: 1px solid var(--border);
		border-radius: 6px;
	}
	.inspector-contract strong {
		display: block;
		color: var(--secondary);
		font-size: 8px;
		font-weight: 570;
	}
	.inspector-contract p {
		margin: 3px 0 0;
		color: var(--muted);
		font-size: 7px;
		line-height: 1.5;
	}

	/* Amber variant of the shared dialog mark, for the non-destructive reset. */
	.reset-mark {
		background: var(--accent-soft);
		border-color: rgb(208 164 92 / 20%);
		color: var(--accent);
	}

	/* ----------------------------------------------------------- breakpoints */

	@media (max-width: 1120px) {
		/* Inspector moves below the conversation and lays out horizontally,
		   dropping the usage and activity detail. */
		.playground-shell {
			grid-template-columns: 190px minmax(410px, 1fr);
			grid-template-rows: minmax(0, 1fr) auto;
		}
		.playground-inspector {
			grid-column: 1 / -1;
			display: grid;
			grid-template-columns: 160px 1fr 1fr;
			border-top: 1px solid var(--border);
			border-left: 0;
		}
		.inspector-head { border-right: 1px solid var(--border); }
		.run-status-card {
			border-right: 1px solid var(--border);
			border-bottom: 0;
		}
		.run-facts { grid-template-columns: repeat(4, minmax(0, 1fr)); }
		.run-usage,
		.activity-heading,
		.activity-timeline,
		.inspector-contract { display: none; }
	}

	@media (max-width: 900px) {
		.playground-topline {
			align-items: flex-start;
			flex-direction: column;
		}
		.playground-controls {
			width: 100%;
			justify-content: flex-start;
			flex-wrap: wrap;
		}
		.playground-controls label { flex: 1; }
		.playground-controls select,
		.playground-controls label:nth-child(2) select { width: 100%; }
		/* Single column; the session list is unreachable at this width. */
		.playground-shell {
			grid-template-columns: 1fr;
			grid-template-rows: none;
			overflow-y: auto;
		}
		.playground-session-panel { display: none; }
		.playground-conversation { min-height: 620px; }
		.playground-inspector { grid-template-columns: 140px 1fr; }
	}

	@media (max-width: 620px) {
		.playground-topline { padding: 13px 14px; }
		.playground-title { width: 100%; }
		.playground-controls label { flex: 1 1 100%; }
		.playground-controls .button { flex: 1; }
		.playground-conversation { min-height: 590px; }
		.conversation-head { padding: 0 12px; }
		.message-stack { padding: 24px 14px 18px; }
		.tool-event { margin-left: 0; }
		.permission-dock {
			align-items: stretch;
			flex-direction: column;
		}
		.permission-actions {
			display: grid;
			grid-template-columns: repeat(2, minmax(0, 1fr));
		}
		.permission-actions .button { width: 100%; }
		.composer-wrap { padding: 8px 10px 11px; }
		.playground-inspector { display: block; }
		.inspector-head,
		.run-status-card { border-right: 0; }
	}
</style>
