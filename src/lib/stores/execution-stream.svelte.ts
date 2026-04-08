import type {
	ExecutionReadModel,
	ExecutionTimelineEvent
} from '$lib/types/execution-stream';

export function createExecutionStream(executionId: string) {
	const stream = $state({
		isConnected: false,
		error: null as string | null,
		snapshot: null as ExecutionReadModel | null,
		events: [] as ExecutionTimelineEvent[],
		activeToolName: null as string | null,
		currentPhase: null as string | null,
		dispose: () => {
			es?.close();
			es = null;
			stream.isConnected = false;
		}
	});
	let es: EventSource | null = null;

	function pushEvent(event: ExecutionTimelineEvent) {
		if (stream.events.some((entry) => entry.id === event.id)) return;
		stream.events = [...stream.events, event].slice(-200);
		switch (event.type) {
			case 'tool_call_start':
				stream.activeToolName =
					(typeof event.data.toolName === 'string' && event.data.toolName) ||
					(typeof event.data.name === 'string' && event.data.name) ||
					stream.activeToolName;
				break;
			case 'tool_call_end':
			case 'tool_call_error':
				stream.activeToolName = null;
				break;
		}

		if (typeof event.data.phase === 'string' && event.data.phase.trim()) {
			stream.currentPhase = event.data.phase;
		}
	}

	function mergeSnapshot(next: Partial<ExecutionReadModel>) {
		if (!stream.snapshot) {
			stream.snapshot = next as ExecutionReadModel;
		} else {
			stream.snapshot = {
				...stream.snapshot,
				...next,
				nodeStatuses: next.nodeStatuses ?? stream.snapshot.nodeStatuses,
				steps: next.steps ?? stream.snapshot.steps,
				browserArtifacts: next.browserArtifacts ?? stream.snapshot.browserArtifacts,
				traceIds: next.traceIds ?? stream.snapshot.traceIds,
				agentEvents: next.agentEvents ?? stream.snapshot.agentEvents
			} as ExecutionReadModel;
		}

		if (stream.snapshot?.agentEvents?.length) {
			stream.events = stream.snapshot.agentEvents;
		}
		stream.currentPhase = stream.snapshot?.phase ?? stream.currentPhase;
	}

	function connect() {
		if (typeof window === 'undefined' || !executionId) return;
		es = new EventSource(`/api/workflows/executions/${executionId}/stream`);

		es.onopen = () => {
			stream.isConnected = true;
			stream.error = null;
		};

		es.onerror = () => {
			stream.isConnected = false;
			stream.error = 'Connection lost';
		};

		es.addEventListener('snapshot', (raw) => {
			try {
				const data = JSON.parse((raw as MessageEvent).data) as ExecutionReadModel;
				mergeSnapshot(data);
			} catch {
				stream.error = 'Failed to parse execution snapshot';
			}
		});

		es.addEventListener('agent_event', (raw) => {
			try {
				const data = JSON.parse((raw as MessageEvent).data) as ExecutionTimelineEvent;
				pushEvent(data);
			} catch {
				stream.error = 'Failed to parse execution event';
			}
		});

		es.addEventListener('terminal', () => {
			stream.isConnected = false;
			stream.activeToolName = null;
		});

		es.addEventListener('run_error', (raw) => {
			try {
				const payload = JSON.parse((raw as MessageEvent).data) as {
					data?: { error?: string };
				};
				stream.error = payload.data?.error ?? 'Execution stream failed';
			} catch {
				stream.error = 'Execution stream failed';
			}
		});
	}

	connect();

	return stream satisfies {
		isConnected: boolean;
		error: string | null;
		snapshot: ExecutionReadModel | null;
		events: ExecutionTimelineEvent[];
		activeToolName: string | null;
		currentPhase: string | null;
		dispose: () => void;
	};
}
