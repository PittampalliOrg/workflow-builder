/**
 * POST /api/workflows/executions/[executionId]/rerun — Rerun a workflow execution
 */

import { eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth-helpers";

export const dynamic = "force-dynamic";
import { allowAnonymousDaprDebug } from "@/lib/dapr/debug-access";
import { getWorkflowOrchestratorUrl } from "@/lib/config-service";
import { genericOrchestratorClient } from "@/lib/dapr-client";
import { db } from "@/lib/db";
import { workflowExecutions } from "@/lib/db/schema";
import { resolveWorkflowExecutionIdAlias } from "@/lib/workflow-execution-alias";

export async function POST(
	request: Request,
	{ params }: { params: Promise<{ executionId: string }> },
) {
	const session = await getSession(request);
	if (!session?.user && !allowAnonymousDaprDebug()) {
		return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
	}

	const { executionId: requestedExecutionId } = await params;

	try {
		const executionId =
			await resolveWorkflowExecutionIdAlias(requestedExecutionId);
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

		if (
			!allowAnonymousDaprDebug() &&
			execution.workflow.userId !== session?.user.id
		) {
			return NextResponse.json({ error: "Forbidden" }, { status: 403 });
		}

		const instanceId = execution.daprInstanceId || execution.id;
		const orchestratorUrl = await getWorkflowOrchestratorUrl();
		const result = await genericOrchestratorClient.rerunWorkflow(
			orchestratorUrl,
			instanceId,
		);
		return NextResponse.json({
			success: result.success,
			newInstanceId: result.newInstanceId,
			newExecutionId: result.newInstanceId,
		});
	} catch (error) {
		console.error("[Rerun Workflow API] Error:", error);
		return NextResponse.json(
			{ error: "Failed to rerun workflow" },
			{ status: 500 },
		);
	}
}
