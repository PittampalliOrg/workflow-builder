import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth-helpers";
import { getJaegerTraceById } from "@/lib/observability/jaeger-client";

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

		return NextResponse.json({ trace });
	} catch (error) {
		console.error("Failed to fetch raw observability trace:", error);
		return NextResponse.json(
			{ error: "Failed to fetch raw observability trace" },
			{ status: 500 },
		);
	}
}
