import type { WorkflowAgentEvent } from "@/lib/db/schema";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { listWorkflowAgentEventsAfterId } from "@/lib/db/workflow-agent-events";
import { workflowExecutions } from "@/lib/db/schema";
import { isValidInternalToken } from "@/lib/internal-api";

export const maxDuration = 1800;

function buildSseChunk(event: WorkflowAgentEvent): string {
	const payload =
		event.payload && typeof event.payload === "object"
			? ({ ...event.payload } as Record<string, unknown>)
			: {};
	if (!payload.id) {
		payload.id = event.sourceEventId;
	}
	if (!payload.ts) {
		payload.ts = event.ts.toISOString();
	}
	if (!payload.type) {
		payload.type = event.eventType;
	}
	return `id: ${String(event.eventId)}\nevent: agent_event\ndata: ${JSON.stringify(payload)}\n\n`;
}

function buildHeartbeatChunk(): string {
	return "event: ping\ndata: {}\n\n";
}

export async function GET(
	request: Request,
	context: { params: Promise<{ executionId: string }> },
) {
	if (!isValidInternalToken(request)) {
		return new Response("Unauthorized", { status: 401 });
	}

	const { executionId } = await context.params;
	const execution = await db.query.workflowExecutions.findFirst({
		where: eq(workflowExecutions.id, executionId),
		columns: { id: true, status: true },
	});
	if (!execution) {
		return new Response("Execution not found", { status: 404 });
	}

	const lastEventId =
		request.headers.get("Last-Event-ID") ??
		new URL(request.url).searchParams.get("lastEventId");
	const encoder = new TextEncoder();
	let currentLastEventId = lastEventId;
	let interval: ReturnType<typeof setInterval> | null = null;

	const stream = new ReadableStream({
		async start(controller) {
			const flushEvents = async () => {
				const events = await listWorkflowAgentEventsAfterId({
					workflowExecutionId: executionId,
					lastEventId: currentLastEventId,
				});
				for (const event of events) {
					currentLastEventId = String(event.eventId);
					controller.enqueue(encoder.encode(buildSseChunk(event)));
				}
			};

			await flushEvents();
			interval = setInterval(() => {
				void flushEvents().catch((error) => {
					console.error("[agent-stream] polling failed:", error);
				});
				controller.enqueue(encoder.encode(buildHeartbeatChunk()));
			}, 1000);
		},
		cancel() {
			if (interval) {
				clearInterval(interval);
				interval = null;
			}
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
