import { NextResponse } from "next/server";
import {
	resolveInternalWorkflow,
	startInternalWorkflowExecution,
} from "@/lib/agent-system/internal-workflows";
import { isValidInternalToken } from "@/lib/internal-api";

type Body = {
	workflowId?: string;
	workflowName?: string;
	triggerData?: Record<string, unknown>;
};

export async function POST(request: Request) {
	if (!isValidInternalToken(request)) {
		return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
	}

	const body = (await request.json().catch(() => ({}))) as Body;
	const workflow = await resolveInternalWorkflow({
		workflowId: body.workflowId,
		workflowName: body.workflowName,
	});

	if (!workflow) {
		return NextResponse.json({ error: "Workflow not found" }, { status: 404 });
	}

	try {
		const started = await startInternalWorkflowExecution({
			workflow,
			triggerData: body.triggerData ?? {},
		});
		return NextResponse.json({
			success: true,
			...started,
		});
	} catch (error) {
		return NextResponse.json(
			{
				error:
					error instanceof Error
						? error.message
						: "Failed to start workflow execution",
			},
			{ status: 500 },
		);
	}
}
