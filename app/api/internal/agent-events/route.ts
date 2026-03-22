import { NextResponse } from "next/server";
import { appendAgentEvents } from "@/lib/agent-events";
import { isValidInternalToken } from "@/lib/internal-api";
import type { AgentStreamEvent } from "@/lib/types/agent-stream-events";

type AgentEventsIngestBody = {
	workflowExecutionId?: string;
	parentExecutionId?: string | null;
	daprInstanceId?: string;
	events?: AgentStreamEvent[];
};

export async function POST(request: Request) {
	if (!isValidInternalToken(request)) {
		return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
	}

	let body: AgentEventsIngestBody;
	try {
		body = (await request.json()) as AgentEventsIngestBody;
	} catch {
		return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
	}

	const workflowExecutionId = body.workflowExecutionId?.trim();
	const daprInstanceId = body.daprInstanceId?.trim();
	const events = Array.isArray(body.events) ? body.events : [];

	if (!workflowExecutionId || !daprInstanceId) {
		return NextResponse.json(
			{ error: "workflowExecutionId and daprInstanceId are required" },
			{ status: 400 },
		);
	}

	const persisted = await appendAgentEvents({
		workflowExecutionId,
		parentExecutionId: body.parentExecutionId ?? null,
		daprInstanceId,
		events,
	});

	return NextResponse.json({
		success: true,
		count: persisted.length,
		lastEventId: persisted.at(-1)?.eventId ?? null,
	});
}
