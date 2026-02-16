import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth-helpers";
import {
	extractTraceCorrelation,
	findTraceContextForProject,
} from "@/lib/observability/correlation";
import { getJaegerTraceById } from "@/lib/observability/jaeger-client";
import { normalizeJaegerTraceDetails } from "@/lib/observability/normalization";
import type { ObservabilityTraceDetailsResponse } from "@/lib/types/observability";

export const dynamic = "force-dynamic";

export async function GET(
	request: Request,
	context: { params: Promise<{ traceId: string }> },
) {
	try {
		const session = await getSession(request);
		if (!session?.user) {
			return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
		}

		const { traceId } = await context.params;
		if (!traceId) {
			return NextResponse.json(
				{ error: "Trace ID is required" },
				{ status: 400 },
			);
		}

		const trace = await getJaegerTraceById(traceId);
		if (!trace) {
			return NextResponse.json({ error: "Trace not found" }, { status: 404 });
		}

		const correlation = extractTraceCorrelation(trace);
		const contextData = await findTraceContextForProject(
			{
				projectId: session.user.projectId,
				userId: session.user.id,
			},
			correlation,
		);

		const hasContext = Boolean(
			contextData.workflowId ||
				contextData.executionId ||
				contextData.daprInstanceId,
		);

		// Hide unmatched traces from project-scoped views.
		if (!hasContext) {
			return NextResponse.json({ error: "Trace not found" }, { status: 404 });
		}

		const normalized = normalizeJaegerTraceDetails(trace, contextData);
		if (!normalized) {
			return NextResponse.json({ error: "Trace not found" }, { status: 404 });
		}

		return NextResponse.json<ObservabilityTraceDetailsResponse>({
			trace: normalized,
		});
	} catch (error) {
		console.error("Failed to fetch observability trace details:", error);
		return NextResponse.json(
			{ error: "Failed to fetch observability trace details" },
			{ status: 500 },
		);
	}
}
