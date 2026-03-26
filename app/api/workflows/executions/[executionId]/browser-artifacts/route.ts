import { eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth-helpers";
import { listWorkflowBrowserArtifactsForExecution } from "@/lib/db/workflow-browser-artifacts";
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

		const artifacts = await listWorkflowBrowserArtifactsForExecution({
			workflowExecutionId: executionId,
		});

		return NextResponse.json({
			success: true,
			executionId,
			count: artifacts.length,
			artifacts,
		});
	} catch (error) {
		return NextResponse.json(
			{
				error:
					error instanceof Error
						? error.message
						: "Failed to load browser artifacts",
			},
			{ status: 500 },
		);
	}
}
