import { eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth-helpers";
import { invokeService } from "@/lib/dapr/client";
import { db } from "@/lib/db";
import { workflowExecutions } from "@/lib/db/schema";

const DURABLE_AGENT_APP_ID =
	process.env.DURABLE_AGENT_APP_ID || "durable-agent";

function shouldMarkPending(status: string): boolean {
	return status === "pending" || status === "running";
}

function errorMessage(data: unknown, fallback: string): string {
	if (!data || typeof data !== "object") {
		return fallback;
	}
	const candidate = (data as Record<string, unknown>).error;
	return typeof candidate === "string" && candidate.length > 0
		? candidate
		: fallback;
}

export async function GET(
	request: Request,
	context: { params: Promise<{ executionId: string }> },
) {
	try {
		const { executionId } = await context.params;
		const session = await getSession(request);

		if (!session?.user) {
			return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
		}

		const execution = await db.query.workflowExecutions.findFirst({
			where: eq(workflowExecutions.id, executionId),
			with: {
				workflow: true,
			},
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

		const response = await invokeService<{
			success?: boolean;
			executionId?: string;
			count?: number;
			changes?: unknown[];
			pending?: boolean;
			error?: string;
		}>({
			appId: DURABLE_AGENT_APP_ID,
			method: "GET",
			path: `/v1.0/invoke/${encodeURIComponent(DURABLE_AGENT_APP_ID)}/method/api/workspaces/executions/${encodeURIComponent(executionId)}/changes`,
			timeout: 15_000,
		});

		if (response.status === 404) {
			const pending = shouldMarkPending(execution.status);
			return NextResponse.json(
				{
					success: true,
					executionId,
					count: 0,
					changes: [],
					pending,
				},
				{
					headers: {
						"Cache-Control": "no-store",
					},
				},
			);
		}

		if (!response.ok || !response.data) {
			return NextResponse.json(
				{
					error: errorMessage(
						response.data,
						"Failed to fetch execution file changes",
					),
				},
				{ status: response.status || 502 },
			);
		}

		return NextResponse.json(response.data, {
			headers: {
				"Cache-Control": "no-store",
			},
		});
	} catch (error) {
		console.error("Failed to load execution change artifacts:", error);
		return NextResponse.json(
			{
				error:
					error instanceof Error
						? error.message
						: "Failed to load execution change artifacts",
			},
			{ status: 500 },
		);
	}
}
