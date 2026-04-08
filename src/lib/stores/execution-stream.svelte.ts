import type {
	ExecutionReadModel,
	ExecutionStepLog,
	ExecutionTimelineEvent
} from '$lib/types/execution-stream';

export function createExecutionStream(executionId: string) {
	const state = $state({
		isConnected: false,
		error: null as string | null,
		snapshot: null as ExecutionReadModel | null,
		events: [] as ExecutionTimelineEvent[],
		activeToolName: null as string | null,
		currentPhase: null as string | null
	});
	let es: EventSource | null = null;

	function pushEvent(event: ExecutionTimelineEvent) {
		if (state.events.some((entry) => entry.id === event.id)) return;
		state.events = [...state.events, event].slice(-200);
		switch (event.type) {
			case 'tool_call_start':
				state.activeToolName =
					(typeof event.data.toolName === 'string' && event.data.toolName) ||
					(typeof event.data.name === 'string' && event.data.name) ||
					state.activeToolName;
				break;
			case 'tool_call_end':
			case 'tool_call_error':
				state.activeToolName = null;
				break;
		}

		if (typeof event.data.phase === 'string' && event.data.phase.trim()) {
			state.currentPhase = event.data.phase;
		}
	}

	function mergeSnapshot(next: Partial<ExecutionReadModel>) {
		if (!state.snapshot) {
			state.snapshot = next as ExecutionReadModel;
		} else {
			state.snapshot = {
				...state.snapshot,
				...next,
				nodeStatuses: next.nodeStatuses ?? state.snapshot.nodeStatuses,
				steps: next.steps ?? state.snapshot.steps,
				browserArtifacts: next.browserArtifacts ?? state.snapshot.browserArtifacts,
				traceIds: next.traceIds ?? state.snapshot.traceIds,
				agentEvents: next.agentEvents ?? state.snapshot.agentEvents
			} as ExecutionReadModel;
		}

		if (state.snapshot?.agentEvents?.length) {
			state.events = state.snapshot.agentEvents;
		}
		state.currentPhase = state.snapshot?.phase ?? state.currentPhase;
	}

	function connect() {
		if (typeof window === 'undefined' || !executionId) return;
		es = new EventSource(`/api/workflows/executions/${executionId}/stream`);

		es.onopen = () => {
			state.isConnected = true;
			state.error = null;
		};

		es.onerror = () => {
			state.isConnected = false;
			state.error = 'Connection lost';
		};

		es.addEventListener('snapshot', (raw) => {
			try {
				const data = JSON.parse((raw as MessageEvent).data) as ExecutionReadModel;
				mergeSnapshot(data);
			} catch {
				state.error = 'Failed to parse execution snapshot';
			}
		});

		es.addEventListener('agent_event', (raw) => {
			try {
				const data = JSON.parse((raw as MessageEvent).data) as ExecutionTimelineEvent;
				pushEvent(data);
			} catch {
				state.error = 'Failed to parse execution event';
			}
		});

		es.addEventListener('terminal', () => {
			state.isConnected = false;
			state.activeToolName = null;
		});

		es.addEventListener('run_error', (raw) => {
			try {
				const payload = JSON.parse((raw as MessageEvent).data) as {
					data?: { error?: string };
				};
				state.error = payload.data?.error ?? 'Execution stream failed';
			} catch {
				state.error = 'Execution stream failed';
			}
		});
	}

	connect();

	return {
		state,
		get status() {
			return state.snapshot?.status ?? 'running';
		},
		get steps(): ExecutionStepLog[] {
			return state.snapshot?.steps ?? [];
		},
		get browserArtifacts() {
			return state.snapshot?.browserArtifacts ?? [];
		},
		dispose() {
			es?.close();
			es = null;
			state.isConnected = false;
		}
	};
}
