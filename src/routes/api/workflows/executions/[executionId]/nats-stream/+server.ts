import type { RequestHandler } from "./$types";
import { getApplicationAdapters } from "$lib/server/application";

/**
 * SSE endpoint for an execution's agent event stream.
 *
 * The path stays at `/nats-stream` for client compatibility. The server-side
 * transport now lives behind `ApplicationWorkflowExecutionStreamService`, which
 * reads snapshots through the execution read-model port and tails persisted
 * session events through workflow-data notification ports.
 */
export const GET: RequestHandler = async ({ params, request }) => {
	// Last-Event-ID is still accepted for client compatibility; replay remains
	// owned by the application stream service's snapshot + notification-tail model.
	void request.headers.get("last-event-id");

	const stream = getApplicationAdapters().workflowExecutionStream.createEventStream({
		executionId: params.executionId,
	});

	return new Response(stream, {
		headers: {
			"Content-Type": "text/event-stream",
			"Cache-Control": "no-cache, no-store, must-revalidate",
			Connection: "keep-alive",
			"X-Accel-Buffering": "no",
		},
	});
};
