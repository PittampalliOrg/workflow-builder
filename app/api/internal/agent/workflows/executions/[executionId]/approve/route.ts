import { NextResponse } from "next/server";
import { approveInternalWorkflowExecution } from "@/lib/agent-system/internal-workflows";
import { isValidInternalToken } from "@/lib/internal-api";

type Body = {
	approved?: boolean;
	reason?: string;
	eventName?: string;
	approvedBy?: string;
};

export async function POST(
	request: Request,
	context: { params: Promise<{ executionId: string }> },
) {
	if (!isValidInternalToken(request)) {
		return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
	}

	const { executionId } = await context.params;
	const body = (await request.json().catch(() => ({}))) as Body;

	try {
		const approved = body.approved !== false;
		const result = await approveInternalWorkflowExecution({
			executionId,
			approved,
			reason: body.reason,
			eventName: body.eventName,
			approvedBy: body.approvedBy?.trim() || "system:internal-api",
		});

		if (!result) {
			return NextResponse.json(
				{ error: "Execution not found" },
				{ status: 404 },
			);
		}

		return NextResponse.json({
			success: true,
			executionId,
			instanceId: result.execution.daprInstanceId,
			eventName: result.eventName,
			approved,
		});
	} catch (error) {
		return NextResponse.json(
			{
				error:
					error instanceof Error
						? error.message
						: "Failed to approve workflow execution",
			},
			{ status: 500 },
		);
	}
}
