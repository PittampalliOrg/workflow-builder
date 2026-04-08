import type {
	ExecutionReadModel,
	ExecutionStepLog,
	ExecutionTimelineEvent
} from '$lib/types/execution-stream';

export function createExecutionStream(executionId: string) {
	let isConnected = $state(false);
	let error = $state<string | null>(null);
	let snapshot = $state<ExecutionReadModel | null>(null);
	let events = $state<ExecutionTimelineEvent[]>([]);
	let activeToolName = $state<string | null>(null);
	let currentPhase = $state<string | null>(null);
	let es: EventSource | null = null;

	function pushEvent(event: ExecutionTimelineEvent) {
		if (events.some((entry) => entry.id === event.id)) return;
		events = [...events, event].slice(-200);
		switch (event.type) {
			case 'tool_call_start':
				activeToolName =
					(typeof event.data.toolName === 'string' && event.data.toolName) ||
					(typeof event.data.name === 'string' && event.data.name) ||
					activeToolName;
				break;
			case 'tool_call_end':
			case 'tool_call_error':
				activeToolName = null;
				break;
		}

		if (typeof event.data.phase === 'string' && event.data.phase.trim()) {
			currentPhase = event.data.phase;
		}
	}

	function mergeSnapshot(next: Partial<ExecutionReadModel>) {
		if (!snapshot) {
			snapshot = next as ExecutionReadModel;
		} else {
			snapshot = {
				...snapshot,
				...next,
				nodeStatuses: next.nodeStatuses ?? snapshot.nodeStatuses,
				steps: next.steps ?? snapshot.steps,
				browserArtifacts: next.browserArtifacts ?? snapshot.browserArtifacts,
				traceIds: next.traceIds ?? snapshot.traceIds,
				agentEvents: next.agentEvents ?? snapshot.agentEvents
			} as ExecutionReadModel;
		}

		if (snapshot?.agentEvents?.length) {
			events = snapshot.agentEvents;
		}
		currentPhase = snapshot?.phase ?? currentPhase;
	}

	function connect() {
		if (typeof window === 'undefined' || !executionId) return;
		es = new EventSource(`/api/workflows/executions/${executionId}/stream`);

		es.onopen = () => {
			isConnected = true;
			error = null;
		};

		es.onerror = () => {
			isConnected = false;
			error = 'Connection lost';
		};

		es.addEventListener('snapshot', (raw) => {
			try {
				const data = JSON.parse((raw as MessageEvent).data) as ExecutionReadModel;
				mergeSnapshot(data);
			} catch {
				error = 'Failed to parse execution snapshot';
			}
		});

		es.addEventListener('agent_event', (raw) => {
			try {
				const data = JSON.parse((raw as MessageEvent).data) as ExecutionTimelineEvent;
				pushEvent(data);
			} catch {
				error = 'Failed to parse execution event';
			}
		});

		es.addEventListener('terminal', () => {
			isConnected = false;
			activeToolName = null;
		});

		es.addEventListener('run_error', (raw) => {
			try {
				const payload = JSON.parse((raw as MessageEvent).data) as {
					data?: { error?: string };
				};
				error = payload.data?.error ?? 'Execution stream failed';
			} catch {
				error = 'Execution stream failed';
			}
		});
	}

	connect();

	return {
		get isConnected() {
			return isConnected;
		},
		get error() {
			return error;
		},
		get snapshot() {
			return snapshot;
		},
		get events() {
			return events;
		},
		get activeToolName() {
			return activeToolName;
		},
		get currentPhase() {
			return currentPhase;
		},
		get status() {
			return snapshot?.status ?? 'running';
		},
		get steps(): ExecutionStepLog[] {
			return snapshot?.steps ?? [];
		},
		get browserArtifacts() {
			return snapshot?.browserArtifacts ?? [];
		},
		dispose() {
			es?.close();
			es = null;
			isConnected = false;
		}
	};
}
