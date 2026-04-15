import type { RequestHandler } from './$types';
import {
	loadExecutionReadModel,
	serializeExecutionReadModel
} from '$lib/server/execution-read-model';
import {
	getJetStream,
	getJetStreamManager,
	WORKFLOW_STREAM_NAME,
	executionSubject,
	isNatsAvailable
} from '$lib/server/nats-client';
import { db } from '$lib/server/db';
import { workflowExecutionLogs } from '$lib/server/db/schema';
import { eq } from 'drizzle-orm';

const HEARTBEAT_INTERVAL_MS = 15_000;
const SNAPSHOT_INTERVAL_MS = 10_000;
const CONSUMER_INACTIVE_THRESHOLD_NS = 10_000_000_000; // 10s in nanoseconds
const FETCH_BATCH_SIZE = 10;
const FETCH_TIMEOUT_MS = 1000;

/**
 * SSE endpoint backed by direct NATS JetStream consumers.
 *
 * Each SSE connection creates an ephemeral pull consumer filtered to
 * `workflow.events.<executionId>`. The consumer is auto-cleaned after 10s
 * of inactivity. Supports browser reconnection via Last-Event-ID → NATS
 * sequence number replay.
 *
 * Falls back to 503 if NATS is unavailable (client should retry with
 * the legacy DB-polling /stream endpoint).
 */
export const GET: RequestHandler = async ({ params, request }) => {
	const executionId = params.executionId;
	const lastEventId = Number.parseInt(
		request.headers.get('last-event-id') ?? '0',
		10
	);
	const isReconnect = Number.isFinite(lastEventId) && lastEventId > 0;

	let cancelled = false;

	const stream = new ReadableStream({
		async start(controller) {
			const encoder = new TextEncoder();
			let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
				let lastSnapshotAt = 0;
				let lastSnapshotHash = '';

			function send(event: string, data: unknown, id?: string | number) {
				if (cancelled) return;
				const payload = typeof data === 'string' ? data : JSON.stringify(data);
				const lines: string[] = [];
				if (id != null) lines.push(`id: ${id}`);
				lines.push(`event: ${event}`);
				lines.push(`data: ${payload}`);
				lines.push('', '');
				try {
					controller.enqueue(encoder.encode(lines.join('\n')));
				} catch {
					cancelled = true;
				}
			}

			function sendComment(text: string) {
				if (cancelled) return;
				try {
					controller.enqueue(encoder.encode(`: ${text}\n\n`));
				} catch {
					cancelled = true;
				}
			}

			try {
				// Flush proxy buffers
				sendComment(' '.repeat(2048));

				// Load initial snapshot from DB (NATS only has events from when publishing was enabled)
				const model = await loadExecutionReadModel(executionId, {
					refreshRuntime: true,
					includeAgentEvents: true
				});

				if (!model) {
					send('error', { error: 'Execution not found' });
					controller.close();
					return;
				}

				const serialized = serializeExecutionReadModel(model, {
					compact: model.status === 'running',
					includeAgentEvents: true
				});
				send('snapshot', serialized);

				// Check if execution is already terminal
				if (['success', 'error', 'cancelled'].includes(model.status)) {
					send('terminal', {
						executionId,
						status: model.status,
						completedAt: model.completedAt,
						error: model.error
					});
					controller.close();
					return;
				}

				// Connect to NATS JetStream
				let js;
				let jsm;
				try {
					js = await getJetStream();
					jsm = await getJetStreamManager();
				} catch (err) {
					// NATS unavailable — send error so client falls back to DB polling
					send('stream_unavailable', {
						error: 'NATS unavailable',
						fallback: true,
						message: err instanceof Error ? err.message : 'Connection failed'
					});
					controller.close();
					return;
				}

				// Build filter subjects for this execution.
				// Subscribe to events from all possible sources:
				// 1. DB execution ID (from agent-stream bridge)
				// 2. Dapr parent instance ID (from orchestrator)
				// 3. Child agent run instance IDs (from agent_runs table)
				// 4. Child workflow instance IDs (from execution_logs output)
				// 5. workflow.stream (catch-all for all agent events)
				const subjectSet = new Set<string>();
				subjectSet.add(executionSubject(executionId));
				if (model.instanceId && model.instanceId !== executionId) {
					subjectSet.add(executionSubject(model.instanceId));
				}
				if (model.agentRuns?.length) {
					for (const run of model.agentRuns) {
						if (run.daprInstanceId) {
							subjectSet.add(executionSubject(run.daprInstanceId));
						}
					}
				}
				// Check execution_logs for child workflow instance IDs
				// (dapr-agent-py child workflows store instanceId in output)
				if (db) {
					try {
						const logs = await db
							.select({ output: workflowExecutionLogs.output })
							.from(workflowExecutionLogs)
							.where(eq(workflowExecutionLogs.executionId, executionId));
						for (const log of logs) {
							const out = log.output as Record<string, unknown> | null;
							if (out?.instanceId && typeof out.instanceId === 'string') {
								subjectSet.add(executionSubject(out.instanceId));
							}
						}
					} catch { /* ignore */ }
				}
				// Only subscribe to per-execution subjects — the agent-stream handler
				// bridges events from workflow.stream to these subjects
				const filterSubjects = [...subjectSet];

				const consumerOpts = {
					filter_subjects: filterSubjects,
					ack_policy: 'none',
					inactive_threshold: CONSUMER_INACTIVE_THRESHOLD_NS,
					// Use DeliverNew — initial state comes from DB snapshot, NATS is for live events only
					...(isReconnect
						? { deliver_policy: 'by_start_sequence', opt_start_seq: lastEventId + 1 }
						: { deliver_policy: 'new' }
					)
				};

				let consumer;
				try {
					const info = await jsm.consumers.add(
						WORKFLOW_STREAM_NAME,
						consumerOpts as Partial<import('nats').ConsumerConfig>
					);
					consumer = await js.consumers.get(WORKFLOW_STREAM_NAME, info.name);
				} catch (err) {
					// Consumer creation failed (stream may not exist or subjects not matched)
					console.warn(`[nats-stream] Failed to create consumer for ${filterSubjects.join(', ')}:`, err);
					send('stream_unavailable', {
						error: 'Consumer creation failed',
						fallback: true,
						message: err instanceof Error ? err.message : 'Failed'
					});
					controller.close();
					return;
				}

				// Start heartbeat timer
				heartbeatTimer = setInterval(() => {
					send('heartbeat', {
						type: 'heartbeat',
						timestamp: new Date().toISOString()
					});
				}, HEARTBEAT_INTERVAL_MS);

				// Streaming loop — fetch messages from pull consumer
				while (!cancelled) {
					try {
						const messages = await consumer.fetch({
							max_messages: FETCH_BATCH_SIZE,
							expires: FETCH_TIMEOUT_MS
						});

						for await (const msg of messages) {
							if (cancelled) break;

							try {
								const data = JSON.parse(new TextDecoder().decode(msg.data));
								const seq = msg.seq;

								// Normalize event for client compatibility
								send('agent_event', {
									id: seq,
									type: data.type || data.data?.type || 'unknown',
									data: data.data || data,
									timestamp: data.timestamp || data.data?.timestamp || new Date().toISOString(),
									executionId: data.executionId || data.data?.executionId,
									runId: data.runId || data.data?.runId,
									callId: data.callId || data.data?.callId,
									source: data.source || data.data?.source,
									sourceEventId:
										data.sourceEventId ||
										data.data?.sourceEventId ||
										data.data?.id ||
										data.id,
									workflowAgentRunId:
										data.workflowAgentRunId ||
										data.data?.workflowAgentRunId,
									daprInstanceId:
										data.daprInstanceId ||
										data.data?.daprInstanceId ||
										data.instanceId ||
										data.data?.instanceId,
									phase: data.phase || data.data?.phase,
									toolName: data.toolName || data.data?.toolName || data.data?.name
								}, seq);
							} catch {
								// Skip malformed messages
							}
						}
					} catch (err) {
						if (cancelled) break;
						// Consumer may have been deleted (timeout) — recreate
						const errMsg = err instanceof Error ? err.message : String(err);
						if (errMsg.includes('consumer not found') || errMsg.includes('404')) {
							console.warn('[nats-stream] Consumer expired, closing stream');
							break;
						}
						// Transient error — continue after brief wait
						await new Promise((r) => setTimeout(r, 500));
					}

					// Periodically refresh execution status from DB (every 3s)
					if (!cancelled && Date.now() - lastSnapshotAt >= SNAPSHOT_INTERVAL_MS) {
						lastSnapshotAt = Date.now();
						try {
							const updated = await loadExecutionReadModel(executionId, {
								refreshRuntime: true,
								includeAgentEvents: false
							});
							if (updated) {
								if (['success', 'error', 'cancelled'].includes(updated.status)) {
									const finalSerialized = serializeExecutionReadModel(updated, { compact: false });
									send('snapshot', finalSerialized);
									send('terminal', {
										executionId,
										status: updated.status,
										completedAt: updated.completedAt,
										error: updated.error
									});
									break;
								}
								const snapHash = JSON.stringify({
									status: updated.status, phase: updated.phase,
									progress: updated.progress, nodeStatuses: updated.nodeStatuses
								});
								if (snapHash !== lastSnapshotHash) {
									lastSnapshotHash = snapHash;
									const snap = serializeExecutionReadModel(updated, { compact: true });
									send('snapshot', snap);
								}
							}
						} catch {
							// DB read failed — continue with NATS events
						}
					}
				}
			} catch (err) {
				if (!cancelled) {
					send('stream_unavailable', {
						error: err instanceof Error ? err.message : 'Stream error'
					});
				}
			} finally {
				if (heartbeatTimer) clearInterval(heartbeatTimer);
				try {
					controller.close();
				} catch {
					// already closed
				}
			}
		},
		cancel() {
			cancelled = true;
		}
	});

	return new Response(stream, {
		headers: {
			'Content-Type': 'text/event-stream',
			'Cache-Control': 'no-cache, no-store, must-revalidate',
			Connection: 'keep-alive',
			'X-Accel-Buffering': 'no'
		}
	});
};
