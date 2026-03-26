import { and, asc, eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth-helpers";
import { db } from "@/lib/db";
import {
	workflowAgentEvents,
	workflowExecutions,
} from "@/lib/db/schema";
import { resolveWorkflowExecutionIdAlias } from "@/lib/workflow-execution-alias";

export async function GET(
	request: Request,
	context: { params: Promise<{ executionId: string }> },
) {
	try {
		const { executionId: requestedExecutionId } = await context.params;
		const executionId =
			await resolveWorkflowExecutionIdAlias(requestedExecutionId);
		const session = await getSession(request);

		if (!session?.user) {
			return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
		}

		const execution = await db.query.workflowExecutions.findFirst({
			where: eq(workflowExecutions.id, executionId),
			with: { workflow: true },
		});

		if (!execution) {
			return NextResponse.json(
				{ error: "Execution not found" },
				{ status: 404 },
			);
		}

		if (execution.workflow.userId !== session.user.id) {
			return NextResponse.json({ error: "Forbidden" }, { status: 403 });
		}

		const url = new URL(request.url);
		const nodeId = url.searchParams.get("nodeId");
		const daprInstanceId = url.searchParams.get("daprInstanceId");
		const agentRunId = url.searchParams.get("agentRunId");

		const conditions = [
			eq(workflowAgentEvents.workflowExecutionId, executionId),
		];
		if (daprInstanceId) {
			conditions.push(
				eq(workflowAgentEvents.daprInstanceId, daprInstanceId),
			);
		}
		if (agentRunId) {
			conditions.push(
				eq(workflowAgentEvents.workflowAgentRunId, agentRunId),
			);
		}

		const events = await db
			.select()
			.from(workflowAgentEvents)
			.where(and(...conditions))
			.orderBy(asc(workflowAgentEvents.eventId));

		// Group events by turn using phase field or sequential turn detection
		type AgentEvent = (typeof events)[number];
		const turns: {
			turn: number;
			phase: string | null;
			events: AgentEvent[];
		}[] = [];
		let currentTurn = 0;
		let currentPhase: string | null = null;

		for (const event of events) {
			// Detect turn boundaries: new turn starts on turn_started event or phase change
			if (
				event.eventType === "turn_started" ||
				(event.phase &&
					event.phase !== currentPhase &&
					event.eventType === "llm_start")
			) {
				currentTurn++;
				currentPhase = event.phase;
				turns.push({ turn: currentTurn, phase: event.phase, events: [] });
			}
			if (turns.length === 0) {
				turns.push({ turn: 1, phase: event.phase, events: [] });
				currentTurn = 1;
			}
			turns[turns.length - 1].events.push(event);
		}

		return NextResponse.json({
			events,
			turns,
			totalEvents: events.length,
			totalTurns: turns.length,
		});
	} catch (error) {
		console.error("Failed to get agent events:", error);
		return NextResponse.json(
			{
				error:
					error instanceof Error
						? error.message
						: "Failed to get agent events",
			},
			{ status: 500 },
		);
	}
}
