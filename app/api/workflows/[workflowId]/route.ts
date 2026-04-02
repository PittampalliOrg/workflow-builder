import { and, eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth-helpers";
import { db } from "@/lib/db";
import { validateWorkflowAppConnections } from "@/lib/db/app-connections";
import { workflows } from "@/lib/db/schema";
import type { WorkflowResourceRefInput } from "@/lib/db/resources";
import {
	isSupportedWorkflowId,
	normalizeWorkflowToSwCutover,
	SW_SPEC_VERSION,
} from "@/lib/serverless-workflow/cutover";
import type { WorkflowEdge, WorkflowNode } from "@/lib/workflow-store";
import { extractPublishedRuntime } from "@/lib/workflow-publishing";
import {
	applyResourcePresetsToNodes,
	persistWorkflowResourceRefs,
} from "@/lib/workflows/apply-resource-presets";
import { normalizeWorkflowNodes } from "@/lib/workflows/normalize-nodes";

// Helper to strip sensitive data from nodes for public viewing
function sanitizeNodesForPublicView(
	nodes: Record<string, unknown>[],
): Record<string, unknown>[] {
	return nodes.map((node) => {
		const sanitizedNode = { ...node };
		if (
			sanitizedNode.data &&
			typeof sanitizedNode.data === "object" &&
			sanitizedNode.data !== null
		) {
			const data = { ...(sanitizedNode.data as Record<string, unknown>) };
			// Remove integrationId from config to not expose which integrations are used
			if (
				data.config &&
				typeof data.config === "object" &&
				data.config !== null
			) {
				const {
					integrationId: _,
					auth: _auth,
					...configWithoutIntegration
				} = data.config as Record<string, unknown>;
				data.config = configWithoutIntegration;
			}
			sanitizedNode.data = data;
		}
		return sanitizedNode;
	});
}

function sanitizeConfigRecord(
	config: Record<string, unknown>,
): Record<string, unknown> {
	const { integrationId: _, auth: _auth, ...rest } = config;
	return rest;
}

function sanitizeSpecForPublicView(spec: unknown): unknown {
	if (!spec || typeof spec !== "object") {
		return spec;
	}
	const record = spec as Record<string, unknown>;
	const trigger =
		record.trigger && typeof record.trigger === "object"
			? (record.trigger as Record<string, unknown>)
			: null;
	const triggerConfig =
		trigger?.config && typeof trigger.config === "object"
			? sanitizeConfigRecord(trigger.config as Record<string, unknown>)
			: trigger?.config;
	const steps = Array.isArray(record.steps)
		? record.steps.map((step) => {
				if (!step || typeof step !== "object") {
					return step;
				}
				const stepRecord = step as Record<string, unknown>;
				return {
					...stepRecord,
					config:
						stepRecord.config && typeof stepRecord.config === "object"
							? sanitizeConfigRecord(
									stepRecord.config as Record<string, unknown>,
								)
							: stepRecord.config,
				};
			})
		: record.steps;
	return {
		...record,
		trigger: trigger
			? {
					...trigger,
					config: triggerConfig,
				}
			: record.trigger,
		steps,
	};
}

function extractSpecMetadata(
	spec: unknown,
): Record<string, unknown> | undefined {
	if (!spec || typeof spec !== "object") {
		return undefined;
	}
	const metadata = (spec as Record<string, unknown>).metadata;
	return metadata && typeof metadata === "object"
		? ({ ...metadata } as Record<string, unknown>)
		: undefined;
}

function applyPreservedSpecMetadata(input: {
	spec: unknown;
	metadata: Record<string, unknown> | undefined;
}): unknown {
	if (!input.metadata || !input.spec || typeof input.spec !== "object") {
		return input.spec;
	}
	return {
		...(input.spec as Record<string, unknown>),
		metadata: input.metadata,
	};
}

export async function GET(
	request: Request,
	context: { params: Promise<{ workflowId: string }> },
) {
	try {
		const { workflowId } = await context.params;
		const session = await getSession(request);

		// First, try to find the workflow
		const workflow = await db.query.workflows.findFirst({
			where: eq(workflows.id, workflowId),
		});

		if (!workflow || !isSupportedWorkflowId(workflowId)) {
			return NextResponse.json(
				{ error: "Workflow not found" },
				{ status: 404 },
			);
		}

		const isOwner = session?.user?.id === workflow.userId;

		// If not owner, check if workflow is public
		if (!isOwner && workflow.visibility !== "public") {
			return NextResponse.json(
				{ error: "Workflow not found" },
				{ status: 404 },
			);
		}

		let normalized;
		try {
			normalized = normalizeWorkflowToSwCutover({
				workflowId,
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
		const [persistedWorkflow] = normalized.needsMigration
			? await db
					.update(workflows)
					.set({
						nodes: normalized.nodes,
						edges: normalized.edges,
						specVersion: normalized.specVersion,
						spec: normalized.spec,
						updatedAt: new Date(),
					})
					.where(eq(workflows.id, workflowId))
					.returning()
			: [workflow];

		// For public workflows viewed by non-owners, sanitize sensitive data
		const responseData = {
			...persistedWorkflow,
			nodes: isOwner
				? normalized.nodes
				: sanitizeNodesForPublicView(
						normalized.nodes as Record<string, unknown>[],
					),
			spec: isOwner
				? normalized.spec
				: sanitizeSpecForPublicView(normalized.spec),
			specVersion: SW_SPEC_VERSION,
			createdAt: persistedWorkflow.createdAt.toISOString(),
			updatedAt: persistedWorkflow.updatedAt.toISOString(),
			isOwner,
			publishedRuntime: extractPublishedRuntime(normalized.spec),
		};

		return NextResponse.json(responseData);
	} catch (error) {
		console.error("Failed to get workflow:", error);
		return NextResponse.json(
			{
				error:
					error instanceof Error ? error.message : "Failed to get workflow",
			},
			{ status: 500 },
		);
	}
}

// Helper to build update data from request body
function buildUpdateData(
	body: Record<string, unknown>,
): Record<string, unknown> {
	const updateData: Record<string, unknown> = {
		updatedAt: new Date(),
	};

	if (body.name !== undefined) {
		updateData.name = body.name;
	}
	if (body.description !== undefined) {
		updateData.description = body.description;
	}
	if (body.nodes !== undefined) {
		updateData.nodes = normalizeWorkflowNodes(body.nodes);
	}
	if (body.edges !== undefined) {
		updateData.edges = body.edges;
	}
	if (body.visibility !== undefined) {
		updateData.visibility = body.visibility;
	}

	return updateData;
}

export async function PATCH(
	request: Request,
	context: { params: Promise<{ workflowId: string }> },
) {
	try {
		const { workflowId } = await context.params;
		const session = await getSession(request);

		if (!session?.user) {
			return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
		}

		// Verify ownership
		const existingWorkflow = await db.query.workflows.findFirst({
			where: and(
				eq(workflows.id, workflowId),
				eq(workflows.userId, session.user.id),
			),
		});

		if (!existingWorkflow || !isSupportedWorkflowId(workflowId)) {
			return NextResponse.json(
				{ error: "Workflow not found" },
				{ status: 404 },
			);
		}

		const body = await request.json();
		let resolvedRefs: WorkflowResourceRefInput[] | null = null;

		// Validate that all connection references in nodes belong to the current user
		if (Array.isArray(body.nodes)) {
			const presetApplied = await applyResourcePresetsToNodes({
				nodes: body.nodes,
				userId: session.user.id,
				projectId: session.user.projectId,
			});
			body.nodes = presetApplied.nodes;
			resolvedRefs = presetApplied.refs;

			const validation = await validateWorkflowAppConnections(
				body.nodes,
				session.user.id,
			);
			if (!validation.valid) {
				return NextResponse.json(
					{ error: "Invalid connection references in workflow" },
					{ status: 403 },
				);
			}
		}

		// Validate visibility value if provided
		if (
			body.visibility !== undefined &&
			body.visibility !== "private" &&
			body.visibility !== "public"
		) {
			return NextResponse.json(
				{ error: "Invalid visibility value. Must be 'private' or 'public'" },
				{ status: 400 },
			);
		}

		const updateData = buildUpdateData(body);

		const effectiveNodes = Array.isArray(body.nodes)
			? (body.nodes as WorkflowNode[])
			: ((existingWorkflow.nodes as WorkflowNode[]) ?? []);
		const effectiveEdges = Array.isArray(body.edges)
			? (body.edges as WorkflowEdge[])
			: ((existingWorkflow.edges as WorkflowEdge[]) ?? []);
		const effectiveName =
			typeof updateData.name === "string"
				? updateData.name
				: existingWorkflow.name;
		const effectiveDescription =
			typeof updateData.description === "string"
				? updateData.description
				: (existingWorkflow.description ?? undefined);
		let normalized;
		try {
			normalized = normalizeWorkflowToSwCutover({
				workflowId,
				name: effectiveName,
				description: effectiveDescription,
				nodes: effectiveNodes,
				edges: effectiveEdges,
				spec:
					body.spec !== undefined
						? body.spec
						: (existingWorkflow as Record<string, unknown>).spec,
				specVersion:
					((existingWorkflow as Record<string, unknown>).specVersion as
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
		updateData.nodes = normalized.nodes;
		updateData.edges = normalized.edges;
		updateData.specVersion = normalized.specVersion;
		updateData.spec = applyPreservedSpecMetadata({
			spec: normalized.spec,
			metadata:
				extractSpecMetadata(body.spec) ??
				extractSpecMetadata((existingWorkflow as Record<string, unknown>).spec),
		});

		const [updatedWorkflow] = await db
			.update(workflows)
			.set(updateData)
			.where(eq(workflows.id, workflowId))
			.returning();

		if (!updatedWorkflow) {
			return NextResponse.json(
				{ error: "Workflow not found" },
				{ status: 404 },
			);
		}

		if (resolvedRefs) {
			await persistWorkflowResourceRefs({
				workflowId: updatedWorkflow.id,
				refs: resolvedRefs,
			});
		}

		return NextResponse.json({
			...updatedWorkflow,
			createdAt: updatedWorkflow.createdAt.toISOString(),
			updatedAt: updatedWorkflow.updatedAt.toISOString(),
			isOwner: true,
		});
	} catch (error) {
		console.error("Failed to update workflow:", error);
		return NextResponse.json(
			{
				error:
					error instanceof Error ? error.message : "Failed to update workflow",
			},
			{ status: 500 },
		);
	}
}

export async function DELETE(
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

		// Verify ownership
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

		return NextResponse.json(
			{ error: "Deleting the supported SW 1.0 workflow is disabled" },
			{ status: 405 },
		);
	} catch (error) {
		console.error("Failed to delete workflow:", error);
		return NextResponse.json(
			{
				error:
					error instanceof Error ? error.message : "Failed to delete workflow",
			},
			{ status: 500 },
		);
	}
}
