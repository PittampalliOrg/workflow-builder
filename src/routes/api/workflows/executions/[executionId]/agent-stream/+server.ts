import type { RequestHandler } from './$types';
import { daprFetch, getOrchestratorUrl } from '$lib/server/dapr-client';

/**
 * GET /api/workflows/executions/[executionId]/agent-stream
 *
 * Returns a Server-Sent Events (SSE) stream of agent events for an execution.
 * Proxies from the orchestrator's SSE endpoint or falls back to DB polling.
 *
 * Event types:
 *   - tool_call_start   — Agent started a tool call
 *   - tool_call_end     — Agent completed a tool call
 *   - llm_token         — LLM streaming token
 *   - llm_complete      — LLM response complete
 *   - sandbox_output    — Sandbox stdout/stderr
 *   - run_complete      — Execution finished successfully
 *   - run_error         — Execution finished with an error
 *   - heartbeat         — Keep-alive ping
 */
export const GET: RequestHandler = async ({ params }) => {
	const { executionId } = params;
	const orchestratorUrl = getOrchestratorUrl();

	const stream = new ReadableStream({
		async start(controller) {
			const encoder = new TextEncoder();
			let cancelled = false;

			function send(event: string, data: unknown) {
				if (cancelled) return;
				const payload = typeof data === 'string' ? data : JSON.stringify(data);
				controller.enqueue(encoder.encode(`event: ${event}\ndata: ${payload}\n\n`));
			}

			// Try to connect to the orchestrator's SSE endpoint
			try {
				const response = await daprFetch(
					`${orchestratorUrl}/api/workflows/${executionId}/events`,
					{
						method: 'GET',
						headers: { Accept: 'text/event-stream' },
						maxRetries: 1
					}
				);

				if (response.ok && response.body) {
					const reader = response.body.getReader();
					const decoder = new TextDecoder();
					let buffer = '';

					try {
						while (!cancelled) {
							const { done, value } = await reader.read();
							if (done) break;

							buffer += decoder.decode(value, { stream: true });
							const lines = buffer.split('\n');
							buffer = lines.pop() || '';

							for (const line of lines) {
								if (cancelled) break;
								// Forward raw SSE lines from the upstream
								if (line.startsWith('data:') || line.startsWith('event:') || line === '') {
									controller.enqueue(encoder.encode(line + '\n'));
								}
							}
						}
					} catch (readErr) {
						if (!cancelled) {
							send('run_error', {
								type: 'run_error',
								data: { error: String(readErr) },
								timestamp: new Date().toISOString()
							});
						}
					} finally {
						reader.releaseLock();
					}
				} else {
					// Orchestrator SSE not available — fall back to polling
					await pollStatus(executionId, orchestratorUrl, send, () => cancelled);
				}
			} catch {
				// Connection failed — fall back to polling
				await pollStatus(executionId, orchestratorUrl, send, () => cancelled);
			}

			if (!cancelled) {
				controller.close();
			}

			// Handle client disconnect
			return () => {
				cancelled = true;
			};
		},

		cancel() {
			// Client disconnected — nothing to clean up beyond the cancelled flag
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

/**
 * Polling fallback: repeatedly check execution status until it reaches
 * a terminal state, emitting synthetic events.
 */
async function pollStatus(
	executionId: string,
	orchestratorUrl: string,
	send: (event: string, data: unknown) => void,
	isCancelled: () => boolean
) {
	const POLL_INTERVAL_MS = 2000;
	const MAX_POLLS = 300; // 10 minutes max

	for (let i = 0; i < MAX_POLLS; i++) {
		if (isCancelled()) return;

		try {
			const response = await daprFetch(
				`${orchestratorUrl}/api/workflows/${executionId}/status`,
				{ method: 'GET', maxRetries: 1 }
			);

			if (response.ok) {
				const status = await response.json();
				const runtimeStatus = (status.runtimeStatus ?? status.status ?? '').toUpperCase();

				send('status', {
					type: 'status',
					data: {
						status: status.status ?? runtimeStatus,
						phase: status.phase,
						progress: status.progress,
						currentNodeId: status.currentNodeId,
						currentNodeName: status.currentNodeName
					},
					timestamp: new Date().toISOString()
				});

				if (['COMPLETED', 'FAILED', 'TERMINATED', 'CANCELED'].includes(runtimeStatus)) {
					const isError = runtimeStatus === 'FAILED';
					send(isError ? 'run_error' : 'run_complete', {
						type: isError ? 'run_error' : 'run_complete',
						data: {
							status: runtimeStatus,
							outputs: status.outputs ?? null,
							error: status.error ?? null
						},
						timestamp: new Date().toISOString()
					});
					return;
				}
			}
		} catch {
			// Polling error — send heartbeat and continue
			send('heartbeat', { type: 'heartbeat', timestamp: new Date().toISOString() });
		}

		await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
	}

	send('run_error', {
		type: 'run_error',
		data: { error: 'Polling timeout exceeded' },
		timestamp: new Date().toISOString()
	});
}
