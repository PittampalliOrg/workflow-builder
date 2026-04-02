import { and, eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth-helpers";
import { db } from "@/lib/db";
import { workflows } from "@/lib/db/schema";
import {
	normalizeWorkflowToSwCutover,
	SUPPORTED_WORKFLOW_ID,
} from "@/lib/serverless-workflow/cutover";
import type { WorkflowEdge, WorkflowNode } from "@/lib/workflow-store";

async function loadSupportedWorkflow(userId: string) {
	return db.query.workflows.findFirst({
		where: and(
			eq(workflows.id, SUPPORTED_WORKFLOW_ID),
			eq(workflows.userId, userId),
		),
	});
}

export async function GET(request: Request) {
	try {
		const session = await getSession(request);
		if (!session?.user) {
			return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
		}

		const workflow = await loadSupportedWorkflow(session.user.id);
		if (!workflow) {
			return NextResponse.json(
				{ error: "Workflow not found" },
				{ status: 404 },
			);
		}

		let normalized;
		try {
			normalized = normalizeWorkflowToSwCutover({
				workflowId: workflow.id,
				name: workflow.name,
				description: workflow.description ?? undefined,
				nodes: workflow.nodes as WorkflowNode[],
				edges: workflow.edges as WorkflowEdge[],
				spec: (workflow as Record<string, unknown>).spec,
				specVersion:
					((workflow as Record<string, unknown>).specVersion as
						| string
						| null
						| undefined) ?? null,
			});
		} catch (error) {
			return NextResponse.json(
				{
					error: "Invalid workflow definition",
					issues: [error instanceof Error ? error.message : "Invalid workflow"],
				},
				{ status: 400 },
			);
		}

		if (normalized.needsMigration) {
			await db
				.update(workflows)
				.set({
					nodes: normalized.nodes,
					edges: normalized.edges,
					specVersion: normalized.specVersion,
					spec: normalized.spec,
					updatedAt: new Date(),
				})
				.where(eq(workflows.id, workflow.id));
		}

		return NextResponse.json({
			id: workflow.id,
			nodes: normalized.nodes,
			edges: normalized.edges,
			specVersion: normalized.specVersion,
			spec: normalized.spec,
		});
	} catch (error) {
		console.error("Failed to get current workflow:", error);
		return NextResponse.json(
			{
				error:
					error instanceof Error
						? error.message
						: "Failed to get current workflow",
			},
			{ status: 500 },
		);
	}
}

export async function POST(request: Request) {
	try {
		const session = await getSession(request);
		if (!session?.user) {
			return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
		}

		const workflow = await loadSupportedWorkflow(session.user.id);
		if (!workflow) {
			return NextResponse.json(
				{ error: "Workflow not found" },
				{ status: 404 },
			);
		}

		const body = (await request.json().catch(() => ({}))) as {
			nodes?: WorkflowNode[];
			edges?: WorkflowEdge[];
		};
		const nodes = Array.isArray(body.nodes)
			? body.nodes
			: (workflow.nodes as WorkflowNode[]);
		const edges = Array.isArray(body.edges)
			? body.edges
			: (workflow.edges as WorkflowEdge[]);

		let normalized;
		try {
			normalized = normalizeWorkflowToSwCutover({
				workflowId: workflow.id,
				name: workflow.name,
				description: workflow.description ?? undefined,
				nodes,
				edges,
				spec: (workflow as Record<string, unknown>).spec,
				specVersion:
					((workflow as Record<string, unknown>).specVersion as
						| string
						| null
						| undefined) ?? null,
			});
		} catch (error) {
			return NextResponse.json(
				{
					error: "Invalid workflow definition",
					issues: [error instanceof Error ? error.message : "Invalid workflow"],
				},
				{ status: 400 },
			);
		}

		const [updated] = await db
			.update(workflows)
			.set({
				nodes: normalized.nodes,
				edges: normalized.edges,
				specVersion: normalized.specVersion,
				spec: normalized.spec,
				updatedAt: new Date(),
			})
			.where(eq(workflows.id, workflow.id))
			.returning();

		return NextResponse.json({
			id: updated.id,
			nodes: normalized.nodes,
			edges: normalized.edges,
			specVersion: normalized.specVersion,
			spec: normalized.spec,
		});
	} catch (error) {
		console.error("Failed to save current workflow:", error);
		return NextResponse.json(
			{
				error:
					error instanceof Error
						? error.message
						: "Failed to save current workflow",
			},
			{ status: 500 },
		);
	}
}
