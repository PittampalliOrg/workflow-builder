import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth-helpers";
import { normalizeWorkflowToSwCutover } from "@/lib/serverless-workflow/cutover";

export async function POST(request: Request) {
	try {
		const session = await getSession(request);
		if (!session?.user) {
			return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
		}

		const body = (await request.json().catch(() => ({}))) as {
			spec?: unknown;
			name?: string;
			description?: string;
		};
		if (!body.spec) {
			return NextResponse.json({ error: "spec is required" }, { status: 400 });
		}

		const normalized = normalizeWorkflowToSwCutover({
			name: body.name?.trim() || "Workflow Preview",
			description: body.description?.trim() || null,
			nodes: [],
			edges: [],
			spec: body.spec,
			specVersion: null,
		});

		return NextResponse.json({
			name: body.name?.trim() || "Workflow Preview",
			description: body.description?.trim() || null,
			spec: normalized.spec,
			specVersion: normalized.specVersion,
			nodes: normalized.nodes,
			edges: normalized.edges,
		});
	} catch (error) {
		console.error("Failed to preview workflow authoring spec:", error);
		return NextResponse.json(
			{
				error:
					error instanceof Error
						? error.message
						: "Failed to preview workflow authoring spec",
			},
			{ status: 500 },
		);
	}
}
