import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth-helpers";
import type { WorkflowGenerationInput } from "@/lib/ai/workflow-authoring/types";
import { generateSwWorkflowWithRepairs } from "@/lib/ai/sw-workflow-generation";
import { normalizeWorkflowToSwCutover } from "@/lib/serverless-workflow/cutover";

export async function POST(request: Request) {
	try {
		const session = await getSession(request);
		if (!session?.user) {
			return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
		}

		const body = (await request
			.json()
			.catch(() => ({}))) as WorkflowGenerationInput;
		const prompt = typeof body.prompt === "string" ? body.prompt.trim() : "";
		if (!prompt) {
			return NextResponse.json(
				{ error: "Prompt is required" },
				{ status: 400 },
			);
		}

		const generated = await generateSwWorkflowWithRepairs({
			...body,
			prompt,
			projectId: session.user.projectId,
		});
		const workflowName =
			body.name?.trim() ||
			generated.spec.document.title ||
			generated.spec.document.name;
		const workflowDescription =
			body.description?.trim() || generated.spec.document.summary;
		const normalized = normalizeWorkflowToSwCutover({
			name: workflowName,
			description: workflowDescription,
			nodes: [],
			edges: [],
			spec: generated.spec,
			specVersion: null,
		});

		return NextResponse.json({
			name: workflowName,
			description: workflowDescription,
			spec: normalized.spec,
			specVersion: normalized.specVersion,
			nodes: normalized.nodes,
			edges: normalized.edges,
			issues: {
				errors: [],
				warnings: generated.warnings,
				repairActions: generated.repairActions,
				unsupportedRequirements: generated.unsupportedRequirements,
			},
		});
	} catch (error) {
		console.error("Failed to generate SW workflow from prompt:", error);
		return NextResponse.json(
			{
				error:
					error instanceof Error
						? error.message
						: "Failed to generate SW workflow from prompt",
			},
			{ status: 500 },
		);
	}
}
