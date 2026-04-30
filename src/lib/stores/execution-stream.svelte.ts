import { writable, type Readable } from 'svelte/store';
import type {
	ExecutionReadModel,
	ExecutionTimelineEvent
} from '$lib/types/execution-stream';
import { eventToolName, eventType, mergeTimelineEvents } from '$lib/utils/execution-timeline';

export interface TokenUsageTotals {
	input: number;
	output: number;
	cacheRead: number;
	cacheCreation: number;
}

export interface TokenRateSample {
	ts: number;
	totalDelta: number;
}

export interface ExecutionStreamState {
	isConnected: boolean;
	error: string | null;
	snapshot: ExecutionReadModel | null;
	events: ExecutionTimelineEvent[];
	activeToolName: string | null;
	currentPhase: string | null;
	isLlmStreaming: boolean;
	llmTokenBuffer: string;
	/** Cumulative tokens this run, summed across every agent.llm_usage event. */
	tokenUsage: TokenUsageTotals;
	/** Last 30 s of (input+output) deltas, for rate gauges. */
	tokenRateWindow: TokenRateSample[];
	/** Latest model id reported by an agent.llm_usage event. */
	currentModel: string | null;
	/** Latest agent.iteration index/max. -1 = unset. */
	iterationIndex: number;
	iterationMax: number;
	/** Number of agent.tool_use events seen this run. */
	toolCallTotal: number;
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
		llmTokenBuffer: '',
		tokenUsage: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 },
		tokenRateWindow: [],
		currentModel: null,
		iterationIndex: -1,
		iterationMax: 0,
		toolCallTotal: 0
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
		if (pollingTimer) {
			clearInterval(pollingTimer);
			pollingTimer = null;
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
	let pollingTimer: ReturnType<typeof setInterval> | null = null;

	function pushEvent(event: ExecutionTimelineEvent) {
		patchState((state) => {
			let activeToolName = state.activeToolName;
			let isLlmStreaming = state.isLlmStreaming;
			let llmTokenBuffer = state.llmTokenBuffer;
			let tokenUsage = state.tokenUsage;
			let tokenRateWindow = state.tokenRateWindow;
			let currentModel = state.currentModel;
			let iterationIndex = state.iterationIndex;
			let iterationMax = state.iterationMax;
			let toolCallTotal = state.toolCallTotal;
			switch (eventType(event)) {
				// Legacy vocabulary (pre-Tier-1). Kept for any non-dapr-agent-py
				// path that still emits these.
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
				// CMA vocabulary (Tier 1/2). session_events carries these for every
				// dapr-agent-py run; the run page now renders them alongside
				// the session-detail page.
				case 'agent.tool_use':
				case 'agent.mcp_tool_use':
				case 'agent.custom_tool_use':
					activeToolName = eventToolName(event) || activeToolName;
					toolCallTotal = state.toolCallTotal + 1;
					break;
				case 'agent.tool_result':
				case 'agent.mcp_tool_result':
				case 'agent.custom_tool_result':
					activeToolName = null;
					break;
				case 'agent.message_delta':
				case 'agent.thinking_delta':
				case 'agent.tool_input_delta':
					isLlmStreaming = true;
					llmTokenBuffer +=
						(typeof event.data.text === 'string' && event.data.text) ||
						(typeof event.data.partial_json === 'string' && event.data.partial_json) ||
						'';
					break;
				case 'agent.message':
				case 'agent.thinking':
					isLlmStreaming = false;
					llmTokenBuffer = '';
					break;
				case 'agent.llm_usage': {
					isLlmStreaming = false;
					llmTokenBuffer = '';
					const d = event.data as Record<string, unknown>;
					const inDelta = numericField(d, 'input_tokens');
					const outDelta = numericField(d, 'output_tokens');
					const cacheReadDelta = numericField(d, 'cache_read_input_tokens');
					const cacheCreateDelta = numericField(d, 'cache_creation_input_tokens');
					tokenUsage = {
						input: state.tokenUsage.input + inDelta,
						output: state.tokenUsage.output + outDelta,
						cacheRead: state.tokenUsage.cacheRead + cacheReadDelta,
						cacheCreation: state.tokenUsage.cacheCreation + cacheCreateDelta
					};
					if (typeof d.model === 'string' && d.model.trim()) {
						currentModel = d.model;
					}
					const totalDelta = inDelta + outDelta;
					if (totalDelta > 0) {
						const ts = Date.now();
						tokenRateWindow = [
							...state.tokenRateWindow.filter((s) => ts - s.ts <= 30_000),
							{ ts, totalDelta }
						];
					}
					break;
				}
				case 'agent.iteration': {
					const d = event.data as Record<string, unknown>;
					const idx = numericField(d, 'index');
					const max = numericField(d, 'max');
					if (idx > 0) iterationIndex = idx;
					if (max > 0) iterationMax = max;
					break;
				}
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
				llmTokenBuffer: llmTokenBuffer.slice(-4000),
				tokenUsage,
				tokenRateWindow,
				currentModel,
				iterationIndex,
				iterationMax,
				toolCallTotal
			};
		});
	}

	function numericField(d: Record<string, unknown>, key: string): number {
		const v = d[key];
		if (typeof v === 'number' && Number.isFinite(v)) return v;
		if (typeof v === 'string') {
			const n = Number(v);
			return Number.isFinite(n) ? n : 0;
		}
		return 0;
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
			const res = await fetch(`/api/workflows/executions/${executionId}/status?includeAgentEvents=true`);
			if (res.ok) {
				const data = (await res.json()) as ExecutionReadModel;
				mergeSnapshot(data);
				if (['success', 'error', 'cancelled'].includes(data.status)) {
					terminal = true;
					if (pollingTimer) {
						clearInterval(pollingTimer);
						pollingTimer = null;
					}
					patchState((state) => ({
						...state,
						isConnected: false,
						activeToolName: null,
						isLlmStreaming: false,
						llmTokenBuffer: ''
					}));
				}
			}
		} catch {
			// Status endpoint also unavailable
		}
	}

	function startPollingFallback(message = 'Live stream unavailable — polling execution status') {
		es?.close();
		es = null;
		if (reconnectTimer) {
			clearTimeout(reconnectTimer);
			reconnectTimer = null;
		}
		if (pollingTimer || terminal) return;
		patchState((state) => ({
			...state,
			isConnected: false,
			error: message
		}));
		void fetchSnapshotFallback();
		pollingTimer = setInterval(fetchSnapshotFallback, 5000);
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

		es.addEventListener('stream_unavailable', (raw) => {
			let message = 'Live stream unavailable — polling execution status';
			try {
				const payload = JSON.parse((raw as MessageEvent).data) as {
					error?: string;
					message?: string;
				};
				message = payload.message || payload.error || message;
			} catch {
				// Use the default fallback message.
			}
			startPollingFallback(message);
		});

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
