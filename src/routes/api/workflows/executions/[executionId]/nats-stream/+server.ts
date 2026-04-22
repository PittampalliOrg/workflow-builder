import type { RequestHandler } from './$types';
import {
	loadExecutionReadModel,
	serializeExecutionReadModel,
	listExecutionAgentEvents
} from '$lib/server/execution-read-model';
import { db, sql } from '$lib/server/db';
import { sessions } from '$lib/server/db/schema';
import { eq } from 'drizzle-orm';

const HEARTBEAT_INTERVAL_MS = 15_000;
const SNAPSHOT_INTERVAL_MS = 10_000;

/**
 * SSE endpoint for an execution's agent event stream.
 *
 * Phase 4 Step 2b migrated agent event publishing from NATS (`workflow.events.*`)
 * to Postgres `session_events` + a pg_notify trigger. This endpoint now tails
 * that notify channel, filtering by the sessions that belong to the given
 * execution via `sessions.workflow_execution_id`.
 *
 * Pipeline:
 *   1. Initial `snapshot` from loadExecutionReadModel (includes all persisted
 *      agent events so far).
 *   2. LISTEN on 'session_events' → on each NOTIFY, if the sessionId belongs
 *      to this execution, call listExecutionAgentEvents(executionId, cursor)
 *      and send each new event as `agent_event`.
 *   3. Every SNAPSHOT_INTERVAL_MS, refresh execution status (phase, progress,
 *      nodeStatuses) and emit an updated `snapshot` if anything changed. Also
 *      refresh the execution's session set so late-spawned sessions get
 *      tracked.
 *   4. On terminal status (success/error/cancelled), emit `terminal` and
 *      close.
 *
 * The path stays at `/nats-stream` for client compatibility — the client's
 * execution-stream.svelte.ts store and its `agent_event` handlers remain
 * identical. Only the server-side transport changed.
 */
export const GET: RequestHandler = async ({ params, request }) => {
	const executionId = params.executionId;
	// Last-Event-ID is still read to support future per-session reconnect
	// replay, but the current implementation falls back to the initial
	// snapshot + LISTEN-tail model for simplicity.
	void request.headers.get('last-event-id');

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

				// Build initial session set for this execution. Each session here
				// is a child workflow session bridged from a `durable/run` step.
				const executionSessions = new Set<string>();
				async function refreshSessions(): Promise<void> {
					if (!db) return;
					try {
						const rows = await db
							.select({ id: sessions.id })
							.from(sessions)
							.where(eq(sessions.workflowExecutionId, executionId));
						for (const r of rows) executionSessions.add(r.id);
					} catch {
						/* transient DB hiccup — keep whatever we had */
					}
				}
				await refreshSessions();

				// Track the max sequence we've already delivered to this client,
				// keyed by sessionId (since session_events.sequence is per-session).
				// Seed from the initial snapshot's agent events.
				const seqBySession = new Map<string, number>();
				for (const ev of model.agentEvents ?? []) {
					const sid = ev.workflowAgentRunId ?? ev.daprInstanceId;
					if (!sid || typeof ev.id !== 'number') continue;
					const cur = seqBySession.get(sid) ?? 0;
					if (ev.id > cur) seqBySession.set(sid, ev.id);
				}

				// Drain any events that landed after our initial snapshot but
				// before LISTEN armed. Per-session cursors handle multi-session
				// executions cleanly (sequence is unique per session, not global).
				async function drainSession(sessionId: string): Promise<void> {
					if (cancelled || !db) return;
					const after = seqBySession.get(sessionId) ?? 0;
					// listExecutionAgentEvents returns all sessions for this exec
					// with sequence > after. In the common single-session case,
					// that's correct. For multi-session we further filter to the
					// notified session to respect per-session cursors.
					const events = await listExecutionAgentEvents(executionId, after);
					for (const ev of events) {
						const sid = ev.workflowAgentRunId ?? ev.daprInstanceId;
						if (sid !== sessionId) continue;
						send('agent_event', ev, ev.id as number);
						if (typeof ev.id === 'number' && ev.id > (seqBySession.get(sessionId) ?? 0)) {
							seqBySession.set(sessionId, ev.id);
						}
					}
				}

				// Arm LISTEN. `sql.listen` subscribes once for the whole
				// process; the callback fires per NOTIFY.
				let unlisten: (() => Promise<void>) | null = null;
				let draining = false;
				let drainAgain = false;
				async function drainLoop(sessionId: string): Promise<void> {
					if (draining) { drainAgain = true; return; }
					draining = true;
					try {
						do {
							drainAgain = false;
							await drainSession(sessionId);
						} while (drainAgain && !cancelled);
					} finally {
						draining = false;
					}
				}
				try {
					const meta = await sql.listen('session_events', (payloadStr: string) => {
						if (cancelled) return;
						let payload: { sessionId?: string } = {};
						try { payload = JSON.parse(payloadStr); } catch { /* fall through */ }
						const sid = payload.sessionId;
						if (!sid) return;
						// If the notified session belongs to this execution,
						// drain its new events. Unknown sessions trigger a
						// cheap refresh — covers late-spawned sessions.
						if (executionSessions.has(sid)) {
							void drainLoop(sid);
						} else {
							void (async () => {
								await refreshSessions();
								if (executionSessions.has(sid)) void drainLoop(sid);
							})();
						}
					});
					unlisten = () => meta.unlisten();
					// Drain each known session once to cover the gap between
					// initial snapshot and LISTEN arm.
					for (const sid of executionSessions) void drainLoop(sid);
				} catch (err) {
					send('stream_unavailable', {
						error: 'LISTEN arm failed',
						fallback: true,
						message: err instanceof Error ? err.message : 'Connection failed'
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

				// Status refresh loop — drives terminal detection, phase/progress
				// updates, and late-spawned-session pickup. Runs until cancel or
				// terminal status.
				try {
					while (!cancelled) {
						await new Promise((r) => setTimeout(r, SNAPSHOT_INTERVAL_MS));
						if (cancelled) break;
						lastSnapshotAt = Date.now();
						try {
							const updated = await loadExecutionReadModel(executionId, {
								refreshRuntime: true,
								includeAgentEvents: false
							});
							if (!updated) continue;
							if (['success', 'error', 'cancelled'].includes(updated.status)) {
								// One last drain on each session to flush any events
								// that might race the terminal transition.
								for (const sid of executionSessions) await drainSession(sid);
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
							// Pick up late-spawned sessions (orchestrator may spawn
							// child sessions minutes into a long-running workflow).
							await refreshSessions();
							const snapHash = JSON.stringify({
								status: updated.status, phase: updated.phase,
								progress: updated.progress, nodeStatuses: updated.nodeStatuses
							});
							if (snapHash !== lastSnapshotHash) {
								lastSnapshotHash = snapHash;
								const snap = serializeExecutionReadModel(updated, { compact: true });
								send('snapshot', snap);
							}
						} catch {
							// Transient DB issue — keep the stream open
						}
					}
				} finally {
					if (unlisten) {
						const u = unlisten;
						unlisten = null;
						void u().catch(() => { /* ignore */ });
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
