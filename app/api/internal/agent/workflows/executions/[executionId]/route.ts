import { NextResponse } from "next/server";
import { getInternalWorkflowExecutionDetail } from "@/lib/agent-system/internal-workflows";
import { isValidInternalToken } from "@/lib/internal-api";

export async function GET(
	request: Request,
	context: { params: Promise<{ executionId: string }> },
) {
	if (!isValidInternalToken(request)) {
		return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
	}

	const { executionId } = await context.params;
	const detail = await getInternalWorkflowExecutionDetail(executionId);

	if (!detail) {
		return NextResponse.json({ error: "Execution not found" }, { status: 404 });
	}

	return NextResponse.json({
		success: true,
		...detail,
	});
}
