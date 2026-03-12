import { eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth-helpers";
import { getOrchestratorUrlAsync } from "@/lib/dapr/config-provider";
import { genericOrchestratorClient } from "@/lib/dapr-client";
import { db } from "@/lib/db";
import { workflowExecutions, workflows } from "@/lib/db/schema";

export async function POST(
	request: Request,
	{ params }: { params: Promise<{ id: string }> },
) {
	try {
		const { id: executionId } = await params;
		const session = await getSession(request);

		if (!session?.user) {
			return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
		}

		const [execution] = await db
			.select()
			.from(workflowExecutions)
			.where(eq(workflowExecutions.id, executionId))
			.limit(1);

		if (!execution) {
			return NextResponse.json(
				{ error: "Execution not found" },
				{ status: 404 },
			);
		}

		const [workflow] = await db
			.select()
			.from(workflows)
			.where(eq(workflows.id, execution.workflowId))
			.limit(1);

		if (
			execution.userId !== session.user.id &&
			(!workflow || workflow.userId !== session.user.id)
		) {
			return NextResponse.json({ error: "Access denied" }, { status: 403 });
		}

		if (!execution.daprInstanceId) {
			return NextResponse.json(
				{ error: "Execution has no Dapr instance" },
				{ status: 400 },
			);
		}

		const defaultUrl = await getOrchestratorUrlAsync();
		const orchestratorUrl = workflow?.daprOrchestratorUrl || defaultUrl;

		const result = await genericOrchestratorClient.resumeWorkflow(
			orchestratorUrl,
			execution.daprInstanceId,
		);

		await db
			.update(workflowExecutions)
			.set({
				status: "running",
				phase: "running",
			})
			.where(eq(workflowExecutions.id, executionId));

		return NextResponse.json({
			success: result.success,
			executionId,
			instanceId: execution.daprInstanceId,
		});
	} catch (error) {
		const errorMessage =
			error instanceof Error ? error.message : "Unknown error";
		console.error("[Orchestrator API] Error resuming workflow:", error);
		return NextResponse.json(
			{ error: "Failed to resume workflow", message: errorMessage },
			{ status: 500 },
		);
	}
}
