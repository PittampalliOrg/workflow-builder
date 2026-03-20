import { NextResponse } from "next/server";
import { listInternalWorkflows } from "@/lib/agent-system/internal-workflows";
import { isValidInternalToken } from "@/lib/internal-api";

export async function GET(request: Request) {
	if (!isValidInternalToken(request)) {
		return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
	}

	const url = new URL(request.url);
	const workflows = await listInternalWorkflows({
		workflowId: url.searchParams.get("workflowId") ?? undefined,
		workflowName: url.searchParams.get("workflowName") ?? undefined,
		userId: url.searchParams.get("userId") ?? undefined,
		projectId: url.searchParams.get("projectId") ?? undefined,
		visibility:
			url.searchParams.get("visibility") === "private" ||
			url.searchParams.get("visibility") === "public"
				? (url.searchParams.get("visibility") as "private" | "public")
				: undefined,
		limit: (() => {
			const rawLimit = url.searchParams.get("limit");
			if (!rawLimit) {
				return undefined;
			}
			const parsed = Number.parseInt(rawLimit, 10);
			return Number.isNaN(parsed) ? undefined : parsed;
		})(),
	});

	return NextResponse.json({
		success: true,
		workflows,
	});
}
