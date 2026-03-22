import { NextResponse } from "next/server";
import { persistWorkflowAgentEvents } from "@/lib/db/workflow-agent-events";
import {
	type WorkflowAgentEventType,
	workflowAgentEvents,
	workflowAgentRuns,
	workflowExecutions,
} from "@/lib/db/schema";
import { db } from "@/lib/db";
import { isValidInternalToken } from "@/lib/internal-api";
import { and, eq, max } from "drizzle-orm";

type IncomingAgentEvent = {
	id?: string;
	ts?: string;
	type?: string;
	agentRunId?: string | null;
	runId?: string | null;
	phase?: string | null;
	toolName?: string | null;
	sandboxName?: string | null;
	traceId?: string | null;
	payload?: Record<string, unknown>;
	[key: string]: unknown;
};

const ALLOWED_EVENT_TYPES = new Set<WorkflowAgentEventType>([
	"run_started",
	"model_start",
	"model_complete",
	"tool_start",
	"tool_complete",
	"tool_error",
	"sandbox_output",
	"sandbox_output_partial",
	"sandbox_heartbeat",
	"run_complete",
	"run_error",
]);

function normalizeIncomingEvent(
	event: IncomingAgentEvent,
	workflowExecutionId: string,
	input: {
		workflowAgentRunId: string | null;
		parentExecutionId: string | null;
		daprInstanceId: string;
		seqStart: number;
		index: number;
	},
) {
	const payloadId = String(event.id ?? "").trim();
	const eventType = String(event.type ?? "").trim() as WorkflowAgentEventType;
	if (!payloadId || !ALLOWED_EVENT_TYPES.has(eventType)) {
		return null;
	}

	const payload = {
		...event,
		id: payloadId,
		type: eventType,
		ts:
			typeof event.ts === "string" && event.ts.trim()
				? event.ts
				: new Date().toISOString(),
	};

	return {
		workflowExecutionId,
		workflowAgentRunId: input.workflowAgentRunId,
		parentExecutionId: input.parentExecutionId,
		daprInstanceId: input.daprInstanceId,
		sourceEventId: payloadId,
		seq: input.seqStart + input.index + 1,
		eventType,
		phase: typeof event.phase === "string" ? event.phase : null,
		toolName: typeof event.toolName === "string" ? event.toolName : null,
		sandboxName:
			typeof event.sandboxName === "string" ? event.sandboxName : null,
		traceId: typeof event.traceId === "string" ? event.traceId : null,
		ts: String(payload.ts),
		payload,
	};
}

export async function POST(
	request: Request,
	context: { params: Promise<{ executionId: string }> },
) {
	if (!isValidInternalToken(request)) {
		return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
	}

	const { executionId } = await context.params;
	const execution = await db.query.workflowExecutions.findFirst({
		where: eq(workflowExecutions.id, executionId),
		columns: { id: true },
	});
	if (!execution) {
		return NextResponse.json({ error: "Execution not found" }, { status: 404 });
	}

	const body = (await request.json().catch(() => ({}))) as {
		agentRunId?: string | null;
		daprInstanceId?: string | null;
		parentExecutionId?: string | null;
		events?: IncomingAgentEvent[];
	};
	const events = Array.isArray(body.events) ? body.events : [];
	const daprInstanceId = String(
		body.daprInstanceId ??
			body.agentRunId ??
			events.find((event) => typeof event.runId === "string")?.runId ??
			"",
	).trim();
	if (!daprInstanceId) {
		return NextResponse.json(
			{ error: "Missing daprInstanceId for agent events" },
			{ status: 400 },
		);
	}

	const workflowAgentRun = await db.query.workflowAgentRuns.findFirst({
		where: and(
			eq(workflowAgentRuns.workflowExecutionId, executionId),
			eq(workflowAgentRuns.daprInstanceId, daprInstanceId),
		),
		columns: { id: true, parentExecutionId: true },
	});
	const [seqRow] = await db
		.select({ maxSeq: max(workflowAgentEvents.seq) })
		.from(workflowAgentEvents)
		.where(
			and(
				eq(workflowAgentEvents.workflowExecutionId, executionId),
				eq(workflowAgentEvents.daprInstanceId, daprInstanceId),
			),
		);
	const seqStart = Number(seqRow?.maxSeq ?? 0);
	const normalized = events
		.map((event, index) =>
			normalizeIncomingEvent(event, executionId, {
				workflowAgentRunId: workflowAgentRun?.id ?? null,
				parentExecutionId:
					workflowAgentRun?.parentExecutionId ?? body.parentExecutionId ?? null,
				daprInstanceId,
				seqStart,
				index,
			}),
		)
		.filter((event): event is NonNullable<typeof event> => Boolean(event));

	if (normalized.length === 0) {
		return NextResponse.json(
			{ error: "No valid agent events provided" },
			{ status: 400 },
		);
	}

	await persistWorkflowAgentEvents(normalized);

	return NextResponse.json({
		success: true,
		executionId,
		persisted: normalized.length,
	});
}
