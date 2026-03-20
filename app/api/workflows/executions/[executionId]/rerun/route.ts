/**
 * POST /api/workflows/executions/[executionId]/rerun — Rerun a workflow execution
 */

import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth-helpers";

export const dynamic = "force-dynamic";
import { allowAnonymousDaprDebug } from "@/lib/dapr/debug-access";
import { getWorkflowOrchestratorUrl } from "@/lib/config-service";
import { genericOrchestratorClient } from "@/lib/dapr-client";

export async function POST(
	request: Request,
	{ params }: { params: Promise<{ executionId: string }> },
) {
	const session = await getSession(request);
	if (!session?.user && !allowAnonymousDaprDebug()) {
		return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
	}

	const { executionId: instanceId } = await params;

	try {
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
