import { and, eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth-helpers";
import { db } from "@/lib/db";
import { workflows } from "@/lib/db/schema";
import {
	isSupportedWorkflowId,
	normalizeWorkflowToSwCutover,
} from "@/lib/serverless-workflow/cutover";
import {
	buildPublishedVersion,
	buildPublishedWorkflowName,
	extractPublishedRuntime,
	sanitizePublishedRevisions,
} from "@/lib/workflow-publishing";
import type {
	JsonValue,
	PublishedRuntimeMetadata,
	PublishedWorkflowRevision,
} from "@/lib/workflow-spec/types";

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

		if (!session?.user) {
			return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
		}

		const existingWorkflow = await db.query.workflows.findFirst({
			where: and(
				eq(workflows.id, workflowId),
				eq(workflows.userId, session.user.id),
			),
		});

		if (!existingWorkflow) {
			return NextResponse.json(
				{ error: "Workflow not found" },
				{ status: 404 },
			);
		}

		const normalized = normalizeWorkflowToSwCutover({
			name: existingWorkflow.name,
			description: existingWorkflow.description ?? undefined,
			nodes: existingWorkflow.nodes as never,
			edges: existingWorkflow.edges as never,
			spec: (existingWorkflow as Record<string, unknown>).spec,
			specVersion:
				((existingWorkflow as Record<string, unknown>).specVersion as
					| string
					| null
					| undefined) ?? null,
		});
		const existingPublishedRuntime = extractPublishedRuntime(normalized.spec);

		const publishedAt = new Date().toISOString();
		const workflowName =
			typeof existingWorkflow.daprWorkflowName === "string" &&
			existingWorkflow.daprWorkflowName.length > 0
				? existingWorkflow.daprWorkflowName
				: existingPublishedRuntime?.workflowName ||
					buildPublishedWorkflowName(existingWorkflow.id);
		const version = buildPublishedVersion();
		const revisions = sanitizePublishedRevisions(
			existingPublishedRuntime?.revisions,
		);
		const definitionSnapshot = JSON.parse(
			JSON.stringify(normalized.spec),
		) as Record<string, JsonValue>;
		const revision: PublishedWorkflowRevision = {
			version,
			publishedAt,
			specVersion: normalized.specVersion,
			definition: definitionSnapshot,
		};
		const publishedRuntime: PublishedRuntimeMetadata = {
			status: "published",
			workflowName,
			latestVersion: version,
			publishedAt,
			revisions: [...revisions, revision],
		};
		const nextSpec = {
			...normalized.spec,
			metadata: {
				...(normalized.spec.metadata ?? {}),
				publishedRuntime,
			},
		};

		const [updatedWorkflow] = await db
			.update(workflows)
			.set({
				daprWorkflowName: workflowName,
				nodes: normalized.nodes,
				edges: normalized.edges,
				specVersion: normalized.specVersion,
				spec: nextSpec,
				updatedAt: new Date(),
			})
			.where(eq(workflows.id, workflowId))
			.returning();

		if (!updatedWorkflow) {
			return NextResponse.json(
				{ error: "Workflow not found" },
				{ status: 404 },
			);
		}

		return NextResponse.json({
			...updatedWorkflow,
			createdAt: updatedWorkflow.createdAt.toISOString(),
			updatedAt: updatedWorkflow.updatedAt.toISOString(),
			publishedRuntime,
		});
	} catch (error) {
		console.error("Failed to publish workflow:", error);
		return NextResponse.json(
			{
				error:
					error instanceof Error ? error.message : "Failed to publish workflow",
			},
			{ status: 500 },
		);
	}
}
