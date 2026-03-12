import { NextResponse } from "next/server";
import { createWorkflowOperationStream } from "@/lib/ai/workflow-generation";
import { getSession } from "@/lib/auth-helpers";
import { createValidatedOperationStream } from "@/lib/ai/validated-operation-stream";

export async function POST(request: Request) {
	try {
		const session = await getSession(request);

		if (!session?.user) {
			return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
		}

		const body = await request.json();
		const { prompt, existingWorkflow, mode } = body as {
			prompt?: unknown;
			existingWorkflow?: unknown;
			mode?: unknown;
		};

		if (!prompt || typeof prompt !== "string") {
			return NextResponse.json(
				{ error: "Prompt is required" },
				{ status: 400 },
			);
		}

		const effectiveMode =
			mode === "classic" || mode === "validated" ? mode : "validated";

		const existingWorkflowObj =
			typeof existingWorkflow === "object" && existingWorkflow
				? (existingWorkflow as any)
				: undefined;

		if (!existingWorkflowObj) {
			return NextResponse.json(
				{
					error:
						"This endpoint only supports incremental edits to an existing workflow. Use /api/workflows/generate-from-prompt or /api/workflows/create-from-prompt for new workflow generation.",
				},
				{ status: 400 },
			);
		}

		const baseStream = await createWorkflowOperationStream({
			prompt,
			existingWorkflow: existingWorkflowObj,
		});

		const stream = await createValidatedOperationStream({
			baseStream,
			prompt,
			existingWorkflow: existingWorkflowObj,
			mode: effectiveMode,
		});

		return new Response(stream, {
			headers: {
				"Content-Type": "application/x-ndjson",
				"Cache-Control": "no-cache",
				Connection: "keep-alive",
			},
		});
	} catch (error) {
		console.error("Failed to edit workflow with AI:", error);
		return NextResponse.json(
			{
				error:
					error instanceof Error
						? error.message
						: "Failed to edit workflow with AI",
			},
			{ status: 500 },
		);
	}
}
