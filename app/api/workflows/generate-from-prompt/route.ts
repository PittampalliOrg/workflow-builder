import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth-helpers";
import { buildRelevantActionListPrompt } from "@/lib/ai/action-list-prompt";
import { generateWorkflowSpecWithRepairs } from "@/lib/ai/workflow-spec-generation";
import { validateWorkflowAppConnections } from "@/lib/db/app-connections";
import { compileWorkflowSpecToGraph } from "@/lib/workflow-spec/compile";
import { loadInstalledWorkflowSpecCatalog } from "@/lib/workflow-spec/catalog-server";
import type { WorkflowSpec } from "@/lib/workflow-spec/types";
import { applyResourcePresetsToNodes } from "@/lib/workflows/apply-resource-presets";
import { normalizeWorkflowNodes } from "@/lib/workflows/normalize-nodes";

export async function POST(request: Request) {
	try {
		const session = await getSession(request);
		if (!session?.user) {
			return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
		}

		const body = (await request.json().catch(() => ({}))) as {
			prompt?: unknown;
			name?: unknown;
			description?: unknown;
		};

		if (typeof body.prompt !== "string" || body.prompt.trim().length === 0) {
			return NextResponse.json(
				{ error: "prompt is required" },
				{ status: 400 },
			);
		}

		const catalog = await loadInstalledWorkflowSpecCatalog();
		const actionListPrompt = buildRelevantActionListPrompt({
			catalog,
			prompt: body.prompt,
			limit: 80,
		});
		const generated = await generateWorkflowSpecWithRepairs({
			prompt: body.prompt,
			actionListPrompt,
		});

		const effectiveSpec: WorkflowSpec = {
			...generated.spec,
			name:
				typeof body.name === "string" && body.name.trim().length > 0
					? body.name.trim()
					: generated.spec.name,
			description:
				typeof body.description === "string"
					? body.description
					: generated.spec.description,
		};

		const { nodes, edges } = compileWorkflowSpecToGraph(effectiveSpec);
		const normalizedNodes = normalizeWorkflowNodes(nodes) as typeof nodes;
		const presetApplied = await applyResourcePresetsToNodes({
			nodes: normalizedNodes as unknown[],
			userId: session.user.id,
			projectId: session.user.projectId,
		});

		const validation = await validateWorkflowAppConnections(
			presetApplied.nodes as unknown[],
			session.user.id,
		);
		if (!validation.valid) {
			return NextResponse.json(
				{
					error: "Invalid connection references in workflow",
					issues: { errors: [], warnings: generated.warnings },
				},
				{ status: 403 },
			);
		}

		return NextResponse.json({
			name: effectiveSpec.name,
			description: effectiveSpec.description,
			spec: effectiveSpec,
			nodes: presetApplied.nodes,
			edges,
			issues: { errors: [], warnings: generated.warnings },
		});
	} catch (error) {
		console.error("Failed to generate workflow from prompt:", error);
		return NextResponse.json(
			{
				error:
					error instanceof Error
						? error.message
						: "Failed to generate workflow from prompt",
			},
			{ status: 500 },
		);
	}
}
