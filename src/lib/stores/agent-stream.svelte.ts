/**
 * Svelte 5 runes-based reactive store for consuming agent SSE streams.
 *
 * Usage:
 *   const stream = createAgentStream(executionId);
 *   // In a component: {stream.events}, {stream.isConnected}, etc.
 */

export interface AgentStreamEvent {
	type: string;
	data: Record<string, unknown>;
	timestamp: string;
}

const MAX_EVENTS = 200;

const TERMINAL_EVENTS = new Set(['run_complete', 'run_error']);

export function createAgentStream(executionId: string) {
	let events = $state<AgentStreamEvent[]>([]);
	let isConnected = $state(false);
	let activeToolName = $state<string | null>(null);
	let currentPhase = $state<string | null>(null);
	let isLlmStreaming = $state(false);
	let llmTokenBuffer = $state('');
	let error = $state<string | null>(null);

	function pushEvent(event: AgentStreamEvent) {
		events = [...events.slice(-(MAX_EVENTS - 1)), event];
	}

	$effect(() => {
		if (!executionId) return;

		const es = new EventSource(`/api/workflows/executions/${executionId}/agent-stream`);

		es.onopen = () => {
			isConnected = true;
			error = null;
		};

		es.onerror = () => {
			isConnected = false;
			error = 'Connection lost';
		};

		// Generic message handler (events without an explicit event type)
		es.onmessage = (e) => {
			try {
				const parsed = JSON.parse(e.data) as AgentStreamEvent;
				handleEvent(parsed);
			} catch {
				// Ignore unparseable messages
			}
		};

		// Named event handlers
		const eventTypes = [
			'tool_call_start',
			'tool_call_end',
			'llm_token',
			'llm_complete',
			'run_complete',
			'run_error',
			'sandbox_output',
			'status',
			'heartbeat'
		];

		for (const type of eventTypes) {
			es.addEventListener(type, (e) => {
				try {
					const parsed = JSON.parse((e as MessageEvent).data);
					handleEvent({ type, data: parsed.data ?? parsed, timestamp: parsed.timestamp ?? new Date().toISOString() });
				} catch {
					// Ignore unparseable
				}
			});
		}

		function handleEvent(event: AgentStreamEvent) {
			pushEvent(event);

			switch (event.type) {
				case 'tool_call_start':
					activeToolName = (event.data.toolName as string) ?? (event.data.name as string) ?? null;
					break;

				case 'tool_call_end':
					activeToolName = null;
					break;

				case 'llm_token':
					isLlmStreaming = true;
					llmTokenBuffer += (event.data.token as string) ?? '';
					break;

				case 'llm_complete':
					isLlmStreaming = false;
					llmTokenBuffer = '';
					break;

				case 'status':
					currentPhase = (event.data.phase as string) ?? currentPhase;
					break;

				case 'run_complete':
				case 'run_error':
					isConnected = false;
					activeToolName = null;
					isLlmStreaming = false;
					if (event.type === 'run_error') {
						error = (event.data.error as string) ?? 'Execution failed';
					}
					es.close();
					break;
			}
		}

		return () => {
			es.close();
			isConnected = false;
		};
	});

	return {
		get events() { return events; },
		get isConnected() { return isConnected; },
		get activeToolName() { return activeToolName; },
		get currentPhase() { return currentPhase; },
		get isLlmStreaming() { return isLlmStreaming; },
		get llmTokenBuffer() { return llmTokenBuffer; },
		get error() { return error; },
		get isTerminal() {
			if (events.length === 0) return false;
			return TERMINAL_EVENTS.has(events[events.length - 1].type);
		}
	};
}
