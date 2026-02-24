import { and, desc, eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth-helpers";
import { db } from "@/lib/db";
import { workflowExecutions, workflowWorkspaceSessions } from "@/lib/db/schema";

export async function GET(
	request: Request,
	context: { params: Promise<{ workflowId: string; executionId: string }> },
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

		const workspaceSession = await db.query.workflowWorkspaceSessions.findFirst({
			where: and(
				eq(workflowWorkspaceSessions.workflowExecutionId, executionId),
				eq(workflowWorkspaceSessions.status, "active"),
			),
			orderBy: [desc(workflowWorkspaceSessions.updatedAt)],
		});

		if (!workspaceSession) {
			return NextResponse.json({ error: "No active sandbox found" }, { status: 404 });
		}

		const sandboxState = workspaceSession.sandboxState as Record<string, any> | null;
		const podIp = sandboxState?.podIp;

		if (!podIp) {
			return NextResponse.json({ error: "Sandbox IP not assigned yet" }, { status: 404 });
		}

		return NextResponse.json({
			podIp,
		});
	} catch (error) {
		console.error("Failed to get sandbox status:", error);
		return NextResponse.json(
			{
				error:
					error instanceof Error
						? error.message
						: "Failed to get sandbox status",
			},
			{ status: 500 },
		);
	}
}