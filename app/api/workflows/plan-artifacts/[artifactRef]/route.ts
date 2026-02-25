import { and, eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth-helpers";
import { db } from "@/lib/db";
import { workflowPlanArtifacts, workflows } from "@/lib/db/schema";

export async function GET(
	request: Request,
	context: { params: Promise<{ artifactRef: string }> },
) {
	try {
		const { artifactRef } = await context.params;
		const id = artifactRef.trim();
		if (!id) {
			return NextResponse.json(
				{ error: "artifactRef is required" },
				{ status: 400 },
			);
		}

		const session = await getSession(request);
		if (!session?.user) {
			return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
		}

		const [artifact] = await db
			.select({
				id: workflowPlanArtifacts.id,
				workflowExecutionId: workflowPlanArtifacts.workflowExecutionId,
				workflowId: workflowPlanArtifacts.workflowId,
				userId: workflowPlanArtifacts.userId,
				nodeId: workflowPlanArtifacts.nodeId,
				workspaceRef: workflowPlanArtifacts.workspaceRef,
				clonePath: workflowPlanArtifacts.clonePath,
				artifactType: workflowPlanArtifacts.artifactType,
				artifactVersion: workflowPlanArtifacts.artifactVersion,
				status: workflowPlanArtifacts.status,
				goal: workflowPlanArtifacts.goal,
				planJson: workflowPlanArtifacts.planJson,
				planMarkdown: workflowPlanArtifacts.planMarkdown,
				sourcePrompt: workflowPlanArtifacts.sourcePrompt,
				metadata: workflowPlanArtifacts.metadata,
				createdAt: workflowPlanArtifacts.createdAt,
				updatedAt: workflowPlanArtifacts.updatedAt,
			})
			.from(workflowPlanArtifacts)
			.where(eq(workflowPlanArtifacts.id, id))
			.limit(1);

		if (!artifact) {
			return NextResponse.json(
				{ error: "Plan artifact not found" },
				{ status: 404 },
			);
		}

		let authorized = artifact.userId === session.user.id;
		if (!authorized) {
			const [workflow] = await db
				.select({ id: workflows.id })
				.from(workflows)
				.where(
					and(
						eq(workflows.id, artifact.workflowId),
						eq(workflows.userId, session.user.id),
					),
				)
				.limit(1);
			authorized = Boolean(workflow);
		}

		if (!authorized) {
			return NextResponse.json({ error: "Forbidden" }, { status: 403 });
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
