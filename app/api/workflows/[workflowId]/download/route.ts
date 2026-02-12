import { and, eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth-helpers";
import { db } from "@/lib/db";
import { workflows } from "@/lib/db/schema";
import { buildDaprExportBundle } from "@/lib/export/dapr-export";
import type { WorkflowEdge, WorkflowNode } from "@/lib/workflow-store";

export async function GET(
	request: Request,
	context: { params: Promise<{ workflowId: string }> },
) {
	try {
		const { workflowId } = await context.params;
		const session = await getSession(request);

		if (!session?.user) {
			return NextResponse.json(
				{ success: false, error: "Unauthorized" },
				{ status: 401 },
			);
		}

		const workflow = await db.query.workflows.findFirst({
			where: and(
				eq(workflows.id, workflowId),
				eq(workflows.userId, session.user.id),
			),
		});

		if (!workflow) {
			return NextResponse.json(
				{ success: false, error: "Workflow not found" },
				{ status: 404 },
			);
		}

		const nodes = Array.isArray(workflow.nodes)
			? (workflow.nodes as WorkflowNode[])
			: [];
		const edges = Array.isArray(workflow.edges)
			? (workflow.edges as WorkflowEdge[])
			: [];

		const bundle = buildDaprExportBundle({
			workflowId: workflow.id,
			workflowName: workflow.name,
			workflowDescription: workflow.description,
			author: session.user.email || session.user.id,
			nodes,
			edges,
		});

		return NextResponse.json({
			success: true,
			files: bundle.files,
		});
	} catch (error) {
		console.error("Failed to prepare workflow download:", error);
		return NextResponse.json(
			{
				success: false,
				error:
					error instanceof Error
						? error.message
						: "Failed to prepare workflow download",
			},
			{ status: 500 },
		);
	}
}
