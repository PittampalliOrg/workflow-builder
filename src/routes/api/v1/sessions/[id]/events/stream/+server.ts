import type { RequestHandler } from "./$types";
import { listEvents } from "$lib/server/sessions/events";
import { getSession } from "$lib/server/sessions/registry";

const HEARTBEAT_INTERVAL_MS = 15_000;
const POLL_INTERVAL_MS = 1500;
const TERMINAL_STATUSES = new Set(["terminated"]);

/**
 * SSE stream of session events. MVP implementation: DB-polling loop that
 * reads everything after the last-known sequence every POLL_INTERVAL_MS.
 * Replay-on-reconnect is supported via the standard `Last-Event-ID` header
 * — clients resume from their last sequence without loss.
 *
 * When the session reaches a terminal status, the stream emits a
 * `session.status_terminated` synthetic (if not already on the log) and
 * closes.
 *
 * Phase 3.5 can swap the poll loop for a NATS subject subscription when
 * dapr-agent-py emits events over NATS; the client contract is the same.
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
			let pollTimer: ReturnType<typeof setInterval> | null = null;

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

			async function poll() {
				if (cancelled) return;
				try {
					const events = await listEvents(sessionId, {
						afterSequence: lastSequence,
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
					}
				} catch (err) {
					write("error", {
						message: err instanceof Error ? err.message : String(err),
					});
				}
			}

			function cleanup() {
				if (heartbeatTimer) clearInterval(heartbeatTimer);
				if (pollTimer) clearInterval(pollTimer);
				heartbeatTimer = null;
				pollTimer = null;
			}

			// Flush any proxy buffers so the browser accepts the stream immediately.
			comment(" ".repeat(2048));
			write("session.snapshot", { session });

			// Initial backfill from the DB.
			await poll();

			heartbeatTimer = setInterval(() => comment("heartbeat"), HEARTBEAT_INTERVAL_MS);
			pollTimer = setInterval(() => void poll(), POLL_INTERVAL_MS);

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
