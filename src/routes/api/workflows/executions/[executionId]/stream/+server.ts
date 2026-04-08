import type { RequestHandler } from './$types';
import {
	listExecutionAgentEvents,
	loadExecutionReadModel,
	serializeExecutionReadModel
} from '$lib/server/execution-read-model';
import type { ExecutionReadModel } from '$lib/types/execution-stream';

const LOOP_INTERVAL_MS = 1000;
const SNAPSHOT_INTERVAL_MS = 2000;
const HEARTBEAT_INTERVAL_MS = 15000;

function stableStringify(value: unknown): string {
	return JSON.stringify(value) ?? 'null';
}

function snapshotKey(model: ExecutionReadModel) {
	return stableStringify({
		status: model.status,
		runtimeStatus: model.runtimeStatus,
		phase: model.phase,
		progress: model.progress,
		currentNodeId: model.currentNodeId,
		currentNodeName: model.currentNodeName,
		traceId: model.traceId,
		traceIds: model.traceIds,
		error: model.error,
		startedAt: model.startedAt,
		completedAt: model.completedAt,
		nodeStatuses: model.nodeStatuses,
		steps: model.steps,
		browserArtifacts: model.browserArtifacts,
		output: model.output,
		summaryOutput: model.summaryOutput
	});
}

export const GET: RequestHandler = async ({ params, url }) => {
	const cursorParam = Number.parseInt(url.searchParams.get('cursor') ?? '0', 10);
	const requestedCursor = Number.isFinite(cursorParam) && cursorParam > 0 ? cursorParam : 0;
	const executionId = params.executionId;
	let cancelled = false;

	const stream = new ReadableStream({
		async start(controller) {
			const encoder = new TextEncoder();
			let lastAgentEventId = requestedCursor;
			let lastSnapshotHash = '';
			let lastSnapshotAt = 0;
			let lastHeartbeatAt = 0;

			function send(event: string, data: unknown, id?: string | number) {
				if (cancelled) return;
				const payload = typeof data === 'string' ? data : JSON.stringify(data);
				const lines = [
					id == null ? null : `id: ${id}`,
					`event: ${event}`,
					`data: ${payload}`,
					''
				].filter(Boolean);
				controller.enqueue(encoder.encode(`${lines.join('\n')}\n`));
			}

			try {
				const initial = await loadExecutionReadModel(executionId, {
					refreshRuntime: true,
					includeAgentEvents: true
				});

				if (!initial) {
					send('run_error', {
						type: 'run_error',
						data: { error: 'Execution not found' },
						timestamp: new Date().toISOString()
					});
					controller.close();
					return;
				}

				const initialSnapshot = serializeExecutionReadModel(initial, {
					compact: true,
					includeAgentEvents: false
				});

				lastAgentEventId = Math.max(lastAgentEventId, initial.lastAgentEventId);
				lastSnapshotHash = snapshotKey(initialSnapshot);
				lastSnapshotAt = Date.now();
				lastHeartbeatAt = Date.now();

				send('snapshot', initialSnapshot);

				for (const event of initial.agentEvents) {
					if (event.id <= requestedCursor) continue;
					send('agent_event', event, event.id);
				}

				while (!cancelled) {
					await new Promise((resolve) => setTimeout(resolve, LOOP_INTERVAL_MS));
					if (cancelled) break;

					const now = Date.now();
					const nextEvents = await listExecutionAgentEvents(executionId, lastAgentEventId);
					for (const event of nextEvents) {
						lastAgentEventId = Math.max(lastAgentEventId, event.id);
						send('agent_event', event, event.id);
					}

					if (now - lastSnapshotAt >= SNAPSHOT_INTERVAL_MS) {
						const snapshot = await loadExecutionReadModel(executionId, {
							refreshRuntime: true,
							includeAgentEvents: false
						});
						if (!snapshot) {
							send('run_error', {
								type: 'run_error',
								data: { error: 'Execution not found' },
								timestamp: new Date().toISOString()
							});
							break;
						}

						const serializedSnapshot = serializeExecutionReadModel(snapshot, {
							compact: true,
							includeAgentEvents: false
						});
						const nextHash = snapshotKey(serializedSnapshot);
						if (nextHash !== lastSnapshotHash) {
							lastSnapshotHash = nextHash;
							send('snapshot', serializedSnapshot);
						}
						lastSnapshotAt = now;

						if (
							snapshot.status === 'success' ||
							snapshot.status === 'error' ||
							snapshot.status === 'cancelled'
						) {
							send('terminal', {
								executionId: snapshot.executionId,
								status: snapshot.status,
								completedAt: snapshot.completedAt,
								error: snapshot.error,
								lastAgentEventId
							});
							break;
						}
					}

					if (now - lastHeartbeatAt >= HEARTBEAT_INTERVAL_MS) {
						send('heartbeat', {
							type: 'heartbeat',
							timestamp: new Date().toISOString(),
							cursor: lastAgentEventId
						});
						lastHeartbeatAt = now;
					}
				}
			} catch (error) {
				send('run_error', {
					type: 'run_error',
					data: {
						error: error instanceof Error ? error.message : 'Execution stream failed'
					},
					timestamp: new Date().toISOString()
				});
			} finally {
				if (!cancelled) controller.close();
			}
		},
		cancel() {
			cancelled = true;
		}
	});

	return new Response(stream, {
		headers: {
			'Content-Type': 'text/event-stream',
			'Cache-Control': 'no-cache',
			Connection: 'keep-alive'
		}
	});
};
