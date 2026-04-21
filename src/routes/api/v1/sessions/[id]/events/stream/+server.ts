import type { RequestHandler } from "./$types";
import { listEvents } from "$lib/server/sessions/events";
import { getSession } from "$lib/server/sessions/registry";
import { sql } from "$lib/server/db";

const HEARTBEAT_INTERVAL_MS = 15_000;
const TERMINAL_STATUSES = new Set(["terminated"]);

/**
 * SSE stream of session events. Backed by Postgres LISTEN/NOTIFY via
 * `postgres-js`'s `sql.listen()`. Migration 0042 installed a trigger on
 * `session_events` that fires `pg_notify('session_events', {...})` on each
 * insert; we subscribe once per open SSE connection, filter by session id,
 * and call `listEvents(sessionId, { afterSequence })` to pull the new row(s).
 *
 * Replay-on-reconnect is preserved via the standard `Last-Event-ID` header
 * — clients resume from their last sequence without loss. The listen socket
 * is owned by the postgres-js client pool, not this connection, so it
 * survives BFF restarts differently from an EventSource: the SSE socket
 * drops, the browser reconnects with Last-Event-ID, and we gap-fill via the
 * initial backfill poll below.
 *
 * When the session reaches a terminal status, the stream emits a
 * `session.terminated` synthetic and closes.
 */
export const GET: RequestHandler = async ({ params, request, locals }) => {
	if (!locals.session?.userId) {
		return new Response("Unauthorized", { status: 401 });
	}
	const sessionId = params.id;
	const lastEventId = Number.parseInt(
		request.headers.get("last-event-id") ?? "0",
		10,
	);
	const startSequence = Number.isFinite(lastEventId) && lastEventId >= 0
		? lastEventId
		: 0;

	const session = await getSession(sessionId);
	if (!session) {
		return new Response("Session not found", { status: 404 });
	}

	let cancelled = false;
	let lastSequence = startSequence;

	const stream = new ReadableStream({
		async start(controller) {
			const encoder = new TextEncoder();
			let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
			let unlisten: (() => Promise<void>) | null = null;
			// Serializes drain() invocations so concurrent notifies don't race
			// on the shared `lastSequence` cursor.
			let draining = false;
			let drainAgain = false;

			function write(event: string, data: unknown, id?: number) {
				if (cancelled) return;
				const payload = typeof data === "string" ? data : JSON.stringify(data);
				const lines: string[] = [];
				if (id !== undefined) lines.push(`id: ${id}`);
				lines.push(`event: ${event}`);
				lines.push(`data: ${payload}`);
				lines.push("", "");
				try {
					controller.enqueue(encoder.encode(lines.join("\n")));
				} catch {
					cancelled = true;
				}
			}

			function comment(text: string) {
				if (cancelled) return;
				try {
					controller.enqueue(encoder.encode(`: ${text}\n\n`));
				} catch {
					cancelled = true;
				}
			}

			async function drain() {
				if (cancelled) return;
				if (draining) {
					drainAgain = true;
					return;
				}
				draining = true;
				try {
					do {
						drainAgain = false;
						const events = await listEvents(sessionId, {
							afterSequence: lastSequence,
							preview: true,
						});
						for (const event of events) {
							write(event.type, event, event.sequence);
							lastSequence = event.sequence;
						}
						// Re-read session to detect terminal transitions emitted out-of-band.
						const current = await getSession(sessionId);
						if (current && TERMINAL_STATUSES.has(current.status)) {
							write("session.terminated", { session: current });
							cleanup();
							controller.close();
							return;
						}
					} while (drainAgain && !cancelled);
				} catch (err) {
					write("error", {
						message: err instanceof Error ? err.message : String(err),
					});
				} finally {
					draining = false;
				}
			}

			function onNotify(payloadStr: string) {
				if (cancelled) return;
				try {
					const payload = JSON.parse(payloadStr) as {
						sessionId?: string;
						sequence?: number;
					};
					if (payload.sessionId !== sessionId) return;
					void drain();
				} catch {
					// Malformed payload — fall back to a drain anyway; cheap enough.
					void drain();
				}
			}

			function cleanup() {
				if (heartbeatTimer) clearInterval(heartbeatTimer);
				heartbeatTimer = null;
				if (unlisten) {
					const u = unlisten;
					unlisten = null;
					void u().catch(() => {
						/* ignore */
					});
				}
			}

			// Flush any proxy buffers so the browser accepts the stream immediately.
			comment(" ".repeat(2048));
			write("session.snapshot", { session });

			// Initial backfill: drain anything that landed before LISTEN was armed.
			await drain();

			// Arm LISTEN only after the backfill so notifications that fire during
			// backfill don't race with the cursor. The listen call itself resolves
			// once the server has acknowledged the LISTEN command.
			if (sql && !cancelled) {
				try {
					const meta = await sql.listen("session_events", onNotify);
					unlisten = () => meta.unlisten();
					// One more drain in case rows landed between backfill and LISTEN arm.
					void drain();
				} catch (err) {
					write("error", {
						message: `LISTEN arm failed: ${err instanceof Error ? err.message : String(err)}`,
					});
				}
			}

			heartbeatTimer = setInterval(() => comment("heartbeat"), HEARTBEAT_INTERVAL_MS);

			request.signal.addEventListener("abort", () => {
				cancelled = true;
				cleanup();
				try {
					controller.close();
				} catch {
					/* ignore */
				}
			});
		},
	});

	return new Response(stream, {
		headers: {
			"content-type": "text/event-stream",
			"cache-control": "no-cache, no-transform",
			connection: "keep-alive",
			"x-accel-buffering": "no",
		},
	});
};
