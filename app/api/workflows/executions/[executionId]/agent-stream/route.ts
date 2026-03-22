import { eq } from "drizzle-orm";
import { listAgentEvents, subscribeToAgentEvents } from "@/lib/agent-events";
import { getSession } from "@/lib/auth-helpers";
import { allowAnonymousDaprDebug } from "@/lib/dapr/debug-access";
import { db } from "@/lib/db";
import { workflowExecutions } from "@/lib/db/schema";
import { isValidInternalToken } from "@/lib/internal-api";
import type { AgentStreamEvent } from "@/lib/types/agent-stream-events";

export const dynamic = "force-dynamic";

function formatSse(event: AgentStreamEvent, eventId: number): Uint8Array {
	return new TextEncoder().encode(
		`id: ${eventId}\nevent: agent_event\ndata: ${JSON.stringify(event)}\n\n`,
	);
}

function snapshotEvent(input: {
	executionId: string;
	status: string;
	phase: string | null;
	progress: number | null;
}): AgentStreamEvent {
	return {
		id: "0",
		type: "state_snapshot",
		ts: new Date().toISOString(),
		phase: input.phase ?? undefined,
		meta: {
			workflowExecutionId: input.executionId,
			status: input.status,
			progress: input.progress,
		},
	};
}

export async function GET(
	request: Request,
	{ params }: { params: Promise<{ executionId: string }> },
) {
	const session = await getSession(request);
	const internalRequest = isValidInternalToken(request);
	if (!session?.user && !internalRequest && !allowAnonymousDaprDebug()) {
		return new Response("Unauthorized", { status: 401 });
	}

	const { executionId } = await params;
	const execution = await db.query.workflowExecutions.findFirst({
		where: eq(workflowExecutions.id, executionId),
		columns: { id: true, status: true, phase: true, progress: true },
	});
	if (!execution) {
		return new Response("Execution not found", { status: 404 });
	}

	const lastEventIdRaw =
		request.headers.get("Last-Event-ID") ??
		new URL(request.url).searchParams.get("lastEventId");
	const afterEventId = lastEventIdRaw
		? Number.parseInt(lastEventIdRaw, 10)
		: null;
	const replayed = await listAgentEvents({
		workflowExecutionId: executionId,
		afterEventId:
			afterEventId != null && Number.isFinite(afterEventId)
				? afterEventId
				: undefined,
	});
	const terminal =
		execution.status === "success" ||
		execution.status === "error" ||
		execution.status === "cancelled";

	const stream = new ReadableStream<Uint8Array>({
		start(controller) {
			let lastSeenEventId =
				afterEventId != null && Number.isFinite(afterEventId)
					? afterEventId
					: 0;

			const enqueueEvent = (event: AgentStreamEvent, eventId: number) => {
				controller.enqueue(formatSse(event, eventId));
				if (eventId > lastSeenEventId) {
					lastSeenEventId = eventId;
				}
			};

			controller.enqueue(
				formatSse(
					snapshotEvent({
						executionId,
						status: execution.status,
						phase: execution.phase ?? null,
						progress: execution.progress ?? null,
					}),
					0,
				),
			);

			for (const event of replayed) {
				enqueueEvent(event, event.eventId);
			}

			if (terminal) {
				controller.close();
				return;
			}

			const unsubscribe = subscribeToAgentEvents(executionId, (event) => {
				if (event.eventId <= lastSeenEventId) {
					return;
				}
				enqueueEvent(event, event.eventId);
			});

			let polling = false;
			const poll = async () => {
				if (polling) {
					return;
				}
				polling = true;
				try {
					const freshEvents = await listAgentEvents({
						workflowExecutionId: executionId,
						afterEventId: lastSeenEventId,
					});
					for (const event of freshEvents) {
						if (event.eventId <= lastSeenEventId) {
							continue;
						}
						enqueueEvent(event, event.eventId);
					}
				} catch {
				} finally {
					polling = false;
				}
			};

			const pollTimer = setInterval(() => {
				void poll();
			}, 2000);
			const keepAlive = setInterval(() => {
				controller.enqueue(new TextEncoder().encode(": keepalive\n\n"));
			}, 30000);

			const abort = () => {
				clearInterval(pollTimer);
				clearInterval(keepAlive);
				unsubscribe();
				try {
					controller.close();
				} catch {}
			};

			request.signal.addEventListener("abort", abort, { once: true });
		},
	});

	return new Response(stream, {
		headers: {
			"Content-Type": "text/event-stream",
			"Cache-Control": "no-cache, no-transform",
			Connection: "keep-alive",
			"X-Accel-Buffering": "no",
		},
	});
}
