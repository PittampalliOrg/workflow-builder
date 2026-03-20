import { NextResponse } from "next/server";
import { listInternalWorkflowExecutions } from "@/lib/agent-system/internal-workflows";
import { isValidInternalToken } from "@/lib/internal-api";

function parseIntegerParam(value: string | null): number | undefined {
	if (!value) {
		return undefined;
	}
	const parsed = Number.parseInt(value, 10);
	return Number.isNaN(parsed) ? undefined : parsed;
}

export async function GET(request: Request) {
	if (!isValidInternalToken(request)) {
		return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
	}

	const url = new URL(request.url);
	const result = await listInternalWorkflowExecutions({
		workflowId: url.searchParams.get("workflowId") ?? undefined,
		workflowName: url.searchParams.get("workflowName") ?? undefined,
		status: url.searchParams.get("status") ?? undefined,
		limit: parseIntegerParam(url.searchParams.get("limit")),
		offset: parseIntegerParam(url.searchParams.get("offset")),
	});

	return NextResponse.json({
		success: true,
		executions: result.executions,
		total: result.total,
	});
}
