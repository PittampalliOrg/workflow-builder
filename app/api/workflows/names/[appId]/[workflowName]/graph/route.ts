/**
 * GET /api/workflows/names/[appId]/[workflowName]/graph — Workflow definition graph
 *
 * Returns the workflow definition as a WorkflowRuntimeGraph (nodes + edges
 * with layout positions, no execution status).
 */

import { eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth-helpers";

export const dynamic = "force-dynamic";
import { allowAnonymousDaprDebug } from "@/lib/dapr/debug-access";
import { db } from "@/lib/db";
import { workflows } from "@/lib/db/schema";
import { buildWorkflowRuntimeGraph } from "@/lib/workflow-runtime-graph";

export async function GET(
	request: Request,
	{ params }: { params: Promise<{ appId: string; workflowName: string }> },
) {
	const session = await getSession(request);
	if (!session?.user && !allowAnonymousDaprDebug()) {
		return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
	}

	const { workflowName } = await params;
	const decodedName = decodeURIComponent(workflowName);

	try {
		const [workflow] = await db
			.select({ nodes: workflows.nodes, edges: workflows.edges })
			.from(workflows)
			.where(eq(workflows.name, decodedName))
			.limit(1);

		if (!workflow) {
			return NextResponse.json(
				{ error: "Workflow not found" },
				{ status: 404 },
			);
		}

		const graph = buildWorkflowRuntimeGraph({
			nodes: workflow.nodes as any,
			edges: workflow.edges as any,
		});

		return NextResponse.json(graph, {
			headers: { "Cache-Control": "no-store" },
		});
	} catch (error) {
		console.error("[Workflow Graph API] Error:", error);
		return NextResponse.json(
			{ error: "Failed to build workflow graph" },
			{ status: 500 },
		);
	}
}
