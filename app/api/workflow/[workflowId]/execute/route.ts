import { eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth-helpers";
import { db } from "@/lib/db";
import { getWorkflowExecutionsSchemaGuardResponse } from "@/lib/db/workflow-executions-schema-guard";
import { workflows } from "@/lib/db/schema";
import { isSupportedWorkflowId } from "@/lib/serverless-workflow/cutover";
import {
	StartSupportedWorkflowExecutionError,
	startSupportedWorkflowExecution,
} from "@/lib/workflows/start-supported-workflow-execution";

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function normalizeExecutionInput(
	workflowId: string,
	input: unknown,
): Record<string, unknown> {
	if (!isPlainObject(input)) {
		return {};
	}
	return input;
}

/**
 * Execute a workflow via the CNCF Serverless Workflow 1.0 interpreter.
 *
 * All workflows are compiled to SW 1.0 format and executed via the
 * sw_workflow_v1 Dapr workflow interpreter. Legacy dynamic_workflow
 * is no longer used for new executions.
 */
export async function POST(
	request: Request,
	context: { params: Promise<{ workflowId: string }> },
) {
	try {
		const { workflowId } = await context.params;
		if (!isSupportedWorkflowId(workflowId)) {
			return NextResponse.json(
				{ error: "Workflow not found" },
				{ status: 404 },
			);
		}

		const session = await getSession(request);
		if (!session) {
			return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
		}

		const schemaGuardResponse =
			await getWorkflowExecutionsSchemaGuardResponse();
		if (schemaGuardResponse) {
			return schemaGuardResponse;
		}

		const workflow = await db.query.workflows.findFirst({
			where: eq(workflows.id, workflowId),
		});

		if (!workflow) {
			return NextResponse.json(
				{ error: "Workflow not found" },
				{ status: 404 },
			);
		}

		if (workflow.userId !== session.user.id) {
			return NextResponse.json({ error: "Forbidden" }, { status: 403 });
		}

		const body = await request.json().catch(() => ({}));
		const input = normalizeExecutionInput(workflowId, body.input);
		try {
			const started = await startSupportedWorkflowExecution({
				request,
				workflow: {
					...workflow,
					userId: session.user.id,
				},
				input,
			});
			return NextResponse.json(started);
		} catch (error) {
			if (error instanceof StartSupportedWorkflowExecutionError) {
				return NextResponse.json(
					{
						error: error.message,
						...(error.issues ? { issues: error.issues } : {}),
					},
					{ status: error.status },
				);
			}
			throw error;
		}
	} catch (error) {
		console.error("Failed to start workflow execution:", error);
		return NextResponse.json(
			{
				error:
					error instanceof Error ? error.message : "Failed to execute workflow",
			},
			{ status: 500 },
		);
	}
}
