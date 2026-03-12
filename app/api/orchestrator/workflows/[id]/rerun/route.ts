import { eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth-helpers";
import { getOrchestratorUrlAsync } from "@/lib/dapr/config-provider";
import { genericOrchestratorClient } from "@/lib/dapr-client";
import { db } from "@/lib/db";
import { getWorkflowExecutionsSchemaGuardResponse } from "@/lib/db/workflow-executions-schema-guard";
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

		const schemaGuardResponse =
			await getWorkflowExecutionsSchemaGuardResponse();
		if (schemaGuardResponse) {
			return schemaGuardResponse;
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

		if (execution.userId !== session.user.id) {
			const [workflow] = await db
				.select()
				.from(workflows)
				.where(eq(workflows.id, execution.workflowId))
				.limit(1);

			if (
				!workflow ||
				(workflow.userId !== session.user.id &&
					workflow.visibility !== "public")
			) {
				return NextResponse.json({ error: "Access denied" }, { status: 403 });
			}
		}

		if (!execution.daprInstanceId) {
			return NextResponse.json(
				{ error: "Execution has no Dapr instance" },
				{ status: 400 },
			);
		}

		const body = await request.json().catch(() => ({}));
		const fromEventId = Number.isFinite(body?.fromEventId)
			? Math.max(0, Number(body.fromEventId))
			: 0;
		const reason =
			typeof body?.reason === "string" && body.reason.trim()
				? body.reason.trim()
				: undefined;

		const [workflow] = await db
			.select()
			.from(workflows)
			.where(eq(workflows.id, execution.workflowId))
			.limit(1);

		const defaultUrl = await getOrchestratorUrlAsync();
		const orchestratorUrl = workflow?.daprOrchestratorUrl || defaultUrl;

		const rerun = await genericOrchestratorClient.rerunWorkflow(
			orchestratorUrl,
			execution.daprInstanceId,
			{ fromEventId, reason },
		);

		const [newExecution] = await db
			.insert(workflowExecutions)
			.values({
				workflowId: execution.workflowId,
				userId: execution.userId,
				status: "running",
				input: execution.input,
				daprInstanceId: rerun.newInstanceId,
				phase: "running",
				progress: 0,
				rerunOfExecutionId: execution.id,
				rerunSourceInstanceId: execution.daprInstanceId,
				rerunFromEventId: rerun.fromEventId,
			})
			.returning();

		return NextResponse.json({
			success: true,
			sourceExecutionId: execution.id,
			sourceInstanceId: execution.daprInstanceId,
			newExecutionId: newExecution.id,
			newInstanceId: rerun.newInstanceId,
			fromEventId: rerun.fromEventId,
			rerunOfExecutionId: newExecution.rerunOfExecutionId,
			rerunSourceInstanceId: newExecution.rerunSourceInstanceId,
			rerunFromEventId: newExecution.rerunFromEventId,
		});
	} catch (error) {
		const errorMessage =
			error instanceof Error ? error.message : "Unknown error";
		console.error("[Orchestrator API] Error rerunning workflow:", error);
		return NextResponse.json(
			{ error: "Failed to rerun workflow", message: errorMessage },
			{ status: 500 },
		);
	}
}
