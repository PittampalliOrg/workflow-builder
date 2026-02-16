import { eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth-helpers";
import { db } from "@/lib/db";
import { validateWorkflowAppConnections } from "@/lib/db/app-connections";
import { workflows } from "@/lib/db/schema";
import { generateId } from "@/lib/utils/id";
import { compileWorkflowSpecToGraph } from "@/lib/workflow-spec/compile";
import { loadInstalledWorkflowSpecCatalog } from "@/lib/workflow-spec/catalog-server";
import { lintWorkflowSpec } from "@/lib/workflow-spec/lint";
import type { WorkflowSpec } from "@/lib/workflow-spec/types";
import { normalizeWorkflowNodes } from "@/lib/workflows/normalize-nodes";

export async function POST(request: Request) {
	try {
		const session = await getSession(request);
		if (!session?.user) {
			return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
		}

		const body = (await request.json().catch(() => ({}))) as {
			name?: unknown;
			description?: unknown;
			spec?: unknown;
		};

		if (!body?.spec) {
			return NextResponse.json({ error: "spec is required" }, { status: 400 });
		}

		const catalog = await loadInstalledWorkflowSpecCatalog();
		const { spec, result } = lintWorkflowSpec(body.spec, {
			catalog,
			unknownActionType: "error",
		});

		if (!spec) {
			return NextResponse.json(
				{ error: "Invalid spec", issues: result },
				{ status: 400 },
			);
		}
		if (result.errors.length > 0) {
			return NextResponse.json(
				{ error: "Spec lint failed", issues: result },
				{ status: 422 },
			);
		}

		const effectiveSpec: WorkflowSpec = {
			...spec,
			name:
				typeof body.name === "string" && body.name.trim().length > 0
					? body.name.trim()
					: spec.name,
			description:
				typeof body.description === "string"
					? body.description
					: spec.description,
		};

		const { nodes, edges } = compileWorkflowSpecToGraph(effectiveSpec);
		const normalizedNodes = normalizeWorkflowNodes(nodes) as typeof nodes;

		const validation = await validateWorkflowAppConnections(
			normalizedNodes as unknown[],
			session.user.id,
		);
		if (!validation.valid) {
			return NextResponse.json(
				{ error: "Invalid connection references in workflow", issues: result },
				{ status: 403 },
			);
		}

		const workflowId = generateId();

		// Generate "Untitled N" name if asked.
		let workflowName = effectiveSpec.name;
		if (workflowName === "Untitled Workflow") {
			const userWorkflows = await db.query.workflows.findMany({
				where: eq(workflows.userId, session.user.id),
			});
			workflowName = `Untitled ${userWorkflows.length + 1}`;
		}

		const [newWorkflow] = await db
			.insert(workflows)
			.values({
				id: workflowId,
				name: workflowName,
				description: effectiveSpec.description,
				nodes: normalizedNodes,
				edges,
				userId: session.user.id,
				projectId: session.user.projectId,
				engineType: "dapr",
			})
			.returning();

		return NextResponse.json({
			workflow: {
				...newWorkflow,
				createdAt: newWorkflow.createdAt.toISOString(),
				updatedAt: newWorkflow.updatedAt.toISOString(),
			},
			issues: result,
		});
	} catch (error) {
		console.error("Failed to create workflow from spec:", error);
		return NextResponse.json(
			{
				error:
					error instanceof Error
						? error.message
						: "Failed to create workflow from spec",
			},
			{ status: 500 },
		);
	}
}
