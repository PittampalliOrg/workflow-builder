import { eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth-helpers";
import { invokeService } from "@/lib/dapr/client";
import { db } from "@/lib/db";
import { workflowExecutions } from "@/lib/db/schema";

const DURABLE_AGENT_APP_ID =
	process.env.DURABLE_AGENT_APP_ID || "durable-agent";

type ChangeArtifactResponse = {
	success?: boolean;
	metadata?: {
		changeSetId: string;
		executionId: string;
		[key: string]: unknown;
	};
	patch?: string;
	error?: string;
};

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
	context: { params: Promise<{ executionId: string; changeSetId: string }> },
) {
	try {
		const { executionId, changeSetId } = await context.params;
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

		const response = await invokeService<ChangeArtifactResponse>({
			appId: DURABLE_AGENT_APP_ID,
			method: "GET",
			path: `/v1.0/invoke/${encodeURIComponent(DURABLE_AGENT_APP_ID)}/method/api/workspaces/changes/${encodeURIComponent(changeSetId)}`,
			timeout: 15_000,
		});

		if (!response.ok || !response.data) {
			return NextResponse.json(
				{
					error: errorMessage(
						response.data,
						"Failed to fetch execution change artifact",
					),
				},
				{ status: response.status || 502 },
			);
		}

		const metadataExecutionId = response.data.metadata?.executionId;
		if (!metadataExecutionId || metadataExecutionId !== executionId) {
			return NextResponse.json(
				{ error: "Change artifact not found for execution" },
				{ status: 404 },
			);
		}

		return NextResponse.json(
			{
				success: true,
				executionId,
				metadata: response.data.metadata,
				patch: response.data.patch ?? "",
			},
			{
				headers: {
					"Cache-Control": "no-store",
				},
			},
		);
	} catch (error) {
		console.error("Failed to load execution change artifact:", error);
		return NextResponse.json(
			{
				error:
					error instanceof Error
						? error.message
						: "Failed to load execution change artifact",
			},
			{ status: 500 },
		);
	}
}
