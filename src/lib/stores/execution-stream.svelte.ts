import { writable, type Readable } from 'svelte/store';
import type {
	ExecutionReadModel,
	ExecutionTimelineEvent
} from '$lib/types/execution-stream';
import { eventToolName, eventType, mergeTimelineEvents } from '$lib/utils/execution-timeline';

export interface ExecutionStreamState {
	isConnected: boolean;
	error: string | null;
	snapshot: ExecutionReadModel | null;
	events: ExecutionTimelineEvent[];
	activeToolName: string | null;
	currentPhase: string | null;
	isLlmStreaming: boolean;
	llmTokenBuffer: string;
}

export type ExecutionStreamStore = Readable<ExecutionStreamState> & {
	dispose: () => void;
};

export function createInitialExecutionStreamState(): ExecutionStreamState {
	return {
		isConnected: false,
		error: null,
		snapshot: null,
		events: [],
		activeToolName: null,
		currentPhase: null,
		isLlmStreaming: false,
		llmTokenBuffer: ''
	};
}

export function createExecutionStream(executionId: string) {
	const { subscribe, update } = writable<ExecutionStreamState>(createInitialExecutionStreamState());

	function patchState(mutator: (state: ExecutionStreamState) => ExecutionStreamState) {
		update((state) => mutator(state));
	}

	function dispose() {
		es?.close();
		es = null;
		if (reconnectTimer) {
			clearTimeout(reconnectTimer);
			reconnectTimer = null;
		}
		patchState((state) => ({
			...state,
			isConnected: false,
			activeToolName: null,
			isLlmStreaming: false,
			llmTokenBuffer: ''
		}));
	}

	const stream: ExecutionStreamStore = {
		subscribe,
		dispose
	};
	let es: EventSource | null = null;
	let terminal = false;

	function pushEvent(event: ExecutionTimelineEvent) {
		patchState((state) => {
			let activeToolName = state.activeToolName;
			let isLlmStreaming = state.isLlmStreaming;
			let llmTokenBuffer = state.llmTokenBuffer;
			switch (eventType(event)) {
				case 'tool_call_start':
					activeToolName = eventToolName(event) || activeToolName;
					break;
				case 'tool_call_end':
				case 'tool_call_error':
					activeToolName = null;
					break;
				case 'llm_start':
					isLlmStreaming = true;
					llmTokenBuffer = '';
					break;
				case 'llm_token':
					isLlmStreaming = true;
					llmTokenBuffer +=
						(typeof event.data.token === 'string' && event.data.token) ||
						(typeof event.data.text === 'string' && event.data.text) ||
						'';
					break;
				case 'llm_complete':
					isLlmStreaming = false;
					llmTokenBuffer = '';
					break;
			}

			const currentPhase =
				typeof event.data.phase === 'string' && event.data.phase.trim()
					? event.data.phase
					: state.currentPhase;

			return {
				...state,
				events: mergeTimelineEvents(state.events, [event]).slice(-200),
				activeToolName,
				currentPhase,
				isLlmStreaming,
				llmTokenBuffer: llmTokenBuffer.slice(-4000)
			};
		});
	}

	function mergeSnapshot(next: Partial<ExecutionReadModel>) {
		patchState((state) => {
			const snapshot = !state.snapshot
				? (next as ExecutionReadModel)
				: ({
						...state.snapshot,
						...next,
						nodeStatuses: next.nodeStatuses ?? state.snapshot.nodeStatuses,
						steps: next.steps ?? state.snapshot.steps,
						browserArtifacts: next.browserArtifacts ?? state.snapshot.browserArtifacts,
						traceIds: next.traceIds ?? state.snapshot.traceIds,
						agentRuns: next.agentRuns ?? state.snapshot.agentRuns,
						workspaces: next.workspaces ?? state.snapshot.workspaces,
						agentEvents: next.agentEvents ?? state.snapshot.agentEvents
					} as ExecutionReadModel);

			return {
				...state,
				snapshot,
				events: mergeTimelineEvents(state.events, snapshot.agentEvents).slice(-200),
				currentPhase: snapshot.phase ?? state.currentPhase
			};
		});
	}

	let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

	async function fetchSnapshotFallback() {
		// When SSE is unavailable, fetch a one-shot snapshot so the UI isn't blank
		try {
			const res = await fetch(`/api/workflows/executions/${executionId}/status`);
			if (res.ok) {
				const data = await res.json();
				mergeSnapshot(data);
			}
		} catch {
			// Status endpoint also unavailable
		}
	}

	function connect() {
		if (typeof window === 'undefined' || !executionId) return;
		if (reconnectTimer) {
			clearTimeout(reconnectTimer);
			reconnectTimer = null;
		}
		es = new EventSource(`/api/workflows/executions/${executionId}/nats-stream`);
		terminal = false;

		es.onopen = () => {
			patchState((state) => ({
				...state,
				isConnected: true,
				error: null
			}));
		};

		es.onerror = () => {
			if (terminal || !es) return;
			es?.close();
			es = null;
			patchState((state) => ({
				...state,
				isConnected: false,
				error: 'Connection lost — retrying...'
			}));
			// Fetch a one-shot snapshot so the UI shows something
			fetchSnapshotFallback();
			// Retry SSE connection after 5s
			reconnectTimer = setTimeout(connect, 5000);
		};

		es.addEventListener('snapshot', (raw) => {
			try {
				const data = JSON.parse((raw as MessageEvent).data) as ExecutionReadModel;
				mergeSnapshot(data);
			} catch {
				patchState((state) => ({
					...state,
					error: 'Failed to parse execution snapshot'
				}));
			}
		});

		es.addEventListener('agent_event', (raw) => {
			try {
				const data = JSON.parse((raw as MessageEvent).data) as ExecutionTimelineEvent;
				pushEvent(data);
			} catch {
				patchState((state) => ({
					...state,
					error: 'Failed to parse execution event'
				}));
			}
		});

		es.addEventListener('terminal', () => {
			terminal = true;
			es?.close();
			es = null;
			patchState((state) => ({
				...state,
				isConnected: false,
				activeToolName: null,
				isLlmStreaming: false,
				llmTokenBuffer: ''
			}));
		});

		es.addEventListener('run_error', (raw) => {
			try {
				const payload = JSON.parse((raw as MessageEvent).data) as {
					data?: { error?: string };
				};
				patchState((state) => ({
					...state,
					error: payload.data?.error ?? 'Execution stream failed',
					isConnected: false
				}));
			} catch {
				patchState((state) => ({
					...state,
					error: 'Execution stream failed',
					isConnected: false
				}));
			}
			terminal = true;
			es?.close();
			es = null;
		});
	}

	connect();

	return stream;
}
