<script lang="ts">
	import { onDestroy, onMount, tick } from "svelte";
	import Avatar from "../shared/Avatar.svelte";
	import Markdown from "../shared/Markdown.svelte";

	type Content =
		| { type: "text"; text: string }
		| { type: "image"; source: { kind: "url"; url: string } | { kind: "base64"; mediaType: string; data: string } };
	type Message =
		| { role: "user" | "assistant"; content: Content[] }
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
	type SessionSnapshot = { eventCursor: number; messages: Message[]; session: SessionSummary };
	type Permission = { requestId: string; toolName: string; toolArguments: Record<string, unknown>; reason: string };
	type GatewayEvent =
		| { type: "assistantTextFragment"; text: string }
		| { type: "error"; message: string }
		| { type: "message"; message: Message }
		| { type: "permissionRequest"; requestId: string; toolName: string; toolArguments: Record<string, unknown>; reason: string }
		| { type: "permissionResolved"; requestId: string; resolution: "approved" | "denied" | "timeout" | "aborted" }
		| { type: "runStarted"; runId: string; modelId: string; startedAt: string }
		| { type: "runCompleted"; runId: string; status: "completed" | "aborted" | "maxIterations" | "failed"; durationMs: number; usage: RunUsage };
	type RunUsage = { inputTokens: number; outputTokens: number; cacheReadTokens: number };
	type ActivityEvent = Exclude<GatewayEvent, { type: "assistantTextFragment" }>;
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
	let optimisticUserText = "";
	let eventSource: EventSource | null = null;
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
		errorMessage = "";
		streamingText = "";
		activities = [];
		permissions = [];
		running = false;
		try {
			const snapshot = await request<SessionSnapshot>(`/api/v1/sessions/${encodeURIComponent(sessionId)}`);
			currentSession = snapshot.session;
			selectedBlueprintId = snapshot.session.blueprintId;
			messages = snapshot.messages;
			cursor = snapshot.eventCursor;
			permissions = await request<Permission[]>(`/api/v1/sessions/${encodeURIComponent(sessionId)}/permissions`);
			running = permissions.length > 0;
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
		closeStream();
		streamState = "connecting";
		const source = new EventSource(`/api/v1/sessions/${encodeURIComponent(currentSession.sessionId)}/events?from=${cursor}`);
		eventSource = source;
		const consumeServerEvent = (messageEvent: MessageEvent<string>) => {
			if (typeof messageEvent.data !== "string" || !messageEvent.data.trim()) return;
			try {
				const event = JSON.parse(messageEvent.data) as GatewayEvent;
				const eventCursor = Number(messageEvent.lastEventId);
				if (Number.isFinite(eventCursor)) cursor = Math.max(cursor, eventCursor + 1);
				handleEvent(event, Number.isFinite(eventCursor) ? eventCursor : cursor);
			} catch {
				errorMessage = "A malformed event was received from the session stream.";
			}
		};
		source.onopen = () => {
			streamState = "connected";
		};
		source.onerror = (event) => {
			// Nox uses a named SSE `error` event for agent failures. EventSource
			// also dispatches a native `error` Event during reconnects; only the
			// former is a MessageEvent with JSON data.
			if (event instanceof MessageEvent) {
				consumeServerEvent(event as MessageEvent<string>);
				return;
			}
			if (eventSource === source) streamState = "reconnecting";
		};
		for (const eventType of ["assistantTextFragment", "message", "permissionRequest", "permissionResolved", "runStarted", "runCompleted"]) {
			source.addEventListener(eventType, (rawEvent) => {
				if (rawEvent instanceof MessageEvent) consumeServerEvent(rawEvent as MessageEvent<string>);
			});
		}
	};

	const handleEvent = (event: GatewayEvent, eventCursor: number) => {
		if (event.type !== "assistantTextFragment") activities = [...activities.slice(-49), { cursor: eventCursor, event, receivedAt: new Date() }];
		if (event.type === "runStarted") {
			currentRunId = event.runId;
			runStatus = "";
			runUsage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 };
			runDurationMs = 0;
			runStartedAt = new Date(event.startedAt);
			elapsedSeconds = 0;
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
			stopElapsedTimer();
			return;
		}
		if (event.type === "assistantTextFragment") {
			streamingText += event.text;
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
		runStatus = "";
		runUsage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 };
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
		eventSource?.close();
		eventSource = null;
		streamState = "idle";
	};
	const startElapsedTimer = () => {
		stopElapsedTimer();
		elapsedTimer = setInterval(() => {
			if (runStartedAt) elapsedSeconds = Math.floor((Date.now() - runStartedAt.getTime()) / 1000);
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
	const textContent = (message: Extract<Message, { role: "user" | "assistant" }>) =>
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
							{#each messages as message}
								{#if message.role === "user" || message.role === "assistant"}
									<article class:assistant={message.role === "assistant"} class="chat-message"><div class="message-author"><Avatar kind={message.role === "user" ? "user" : "blueprint"} seed={message.role === "user" ? "nox-local-user" : `blueprint:${selectedBlueprint?.id ?? "unknown"}`} size={28} decorative /><strong>{message.role === "user" ? "You" : selectedBlueprint?.id}</strong></div><div class="message-body"><Markdown source={textContent(message)} />{#each message.content.filter((item) => item.type === "image") as image}<img src={image.source.kind === "url" ? image.source.url : `data:${image.source.mediaType};base64,${image.source.data}`} alt="Message attachment" />{/each}</div></article>
								{:else if message.role === "toolCall"}
									<article class="tool-event call"><div class="tool-event-icon">⌘</div><div><span>Tool call</span><strong>{message.name}</strong><pre>{JSON.stringify(message.arguments, null, 2)}</pre></div></article>
								{:else}
									<article class:error={message.isError} class="tool-event response"><div class="tool-event-icon">{message.isError ? "!" : "✓"}</div><div><span>{message.execution === "deferredAck" ? "Deferred tool accepted" : message.execution === "deferredResult" ? "Deferred result" : "Tool response"}</span><strong>{message.name}</strong><pre>{responseText(message) || "No textual output"}</pre></div></article>
								{/if}
							{/each}
							{#if streamingText}<article class="chat-message assistant streaming"><div class="message-author"><Avatar kind="blueprint" seed={`blueprint:${selectedBlueprint?.id ?? "unknown"}`} size={28} decorative /><strong>{selectedBlueprint?.id}</strong><i></i></div><div class="message-body"><Markdown source={streamingText} /><span class="stream-caret"></span></div></article>{/if}
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
				<div class="run-facts"><div><span>Messages</span><strong>{messages.length}</strong></div><div><span>Responses</span><strong>{assistantCount}</strong></div><div><span>Tool calls</span><strong>{toolCallCount}</strong></div><div><span>Event cursor</span><strong>{cursor}</strong></div></div>
				<div class="run-usage"><div class="run-usage-head"><span>Measured usage</span><strong>{runUsage.inputTokens + runUsage.outputTokens} tokens</strong></div><div><span>Input</span><strong>{runUsage.inputTokens.toLocaleString()}</strong></div><div><span>Output</span><strong>{runUsage.outputTokens.toLocaleString()}</strong></div><div><span>Cache read</span><strong>{runUsage.cacheReadTokens.toLocaleString()}</strong></div></div>
				{#if permissions.length > 0}<div class="inspector-attention"><span>!</span><div><strong>Run paused</strong><p>A protected tool is waiting for your decision.</p></div></div>{/if}
				<div class="activity-heading"><span>Live activity</span><strong>{activities.length}</strong></div>
				<div class="activity-timeline">
					{#each activities.slice(-8).reverse() as activity}<div class:error={activity.event.type === "error"} class="activity-item"><span></span><div><strong>{activityLabel(activity)}</strong><small>{activity.receivedAt.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })} · #{activity.cursor}</small></div></div>{:else}<div class="activity-empty"><span>···</span><p>Run events will appear here.</p></div>{/each}
				</div>
				<div class="inspector-contract"><strong>Run-local measurements</strong><p>Usage reflects provider-reported tokens for the latest run. Cost estimation is not configured.</p></div>
			</aside>
		</div>
	{/if}

	{#if clearOpen}<div class="dialog-backdrop" role="presentation" onclick={(event) => { if (event.target === event.currentTarget) clearOpen = false; }}><div class="confirm-dialog" role="dialog" aria-modal="true" aria-labelledby="clear-session-title"><div class="dialog-danger-mark reset-mark">↻</div><h2 id="clear-session-title">Clear this session?</h2><p>The stored conversation will be deleted and replaced with a fresh session using the same blueprint.</p><div class="dialog-actions"><button class="button secondary" type="button" onclick={() => (clearOpen = false)}>Cancel</button><button class="button danger" type="button" onclick={clearSession} disabled={clearing}>{clearing ? "Clearing…" : "Clear session"}</button></div></div></div>{/if}
</section>
