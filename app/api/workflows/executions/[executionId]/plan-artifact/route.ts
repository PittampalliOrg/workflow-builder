import { eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth-helpers";
import { getLatestWorkflowPlanArtifactForExecution } from "@/lib/db/workflow-plan-artifacts";
import { db } from "@/lib/db";
import { workflowExecutions, workflows } from "@/lib/db/schema";

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
			if (!workflow || workflow.userId !== session.user.id) {
				return NextResponse.json({ error: "Forbidden" }, { status: 403 });
			}
		}

		const url = new URL(request.url);
		const nodeId = url.searchParams.get("nodeId")?.trim() || undefined;
		const artifact = await getLatestWorkflowPlanArtifactForExecution({
			workflowExecutionId: executionId,
			nodeId,
		});
		if (!artifact) {
			return NextResponse.json(
				{ error: "Plan artifact not found" },
				{ status: 404 },
			);
		}

		return NextResponse.json({
			success: true,
			artifact,
		});
	} catch (error) {
		return NextResponse.json(
			{
				error:
					error instanceof Error
						? error.message
						: "Failed to load plan artifact",
			},
			{ status: 500 },
		);
	}
}
