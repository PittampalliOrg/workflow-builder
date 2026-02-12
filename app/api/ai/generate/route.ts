import { NextResponse } from "next/server";
import { createWorkflowOperationStream } from "@/lib/ai/workflow-generation";
import { getSession } from "@/lib/auth-helpers";

export async function POST(request: Request) {
	try {
		const session = await getSession(request);

		if (!session?.user) {
			return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
		}

		const body = await request.json();
		const { prompt, existingWorkflow } = body;

		if (!prompt || typeof prompt !== "string") {
			return NextResponse.json(
				{ error: "Prompt is required" },
				{ status: 400 },
			);
		}

		const apiKey = process.env.AI_GATEWAY_API_KEY || process.env.OPENAI_API_KEY;

		if (!apiKey) {
			return NextResponse.json(
				{
					error: "AI API key not configured on server. Please contact support.",
				},
				{ status: 500 },
			);
		}

		const stream = await createWorkflowOperationStream({
			prompt,
			existingWorkflow,
		});

		return new Response(stream, {
			headers: {
				"Content-Type": "application/x-ndjson",
				"Cache-Control": "no-cache",
				Connection: "keep-alive",
			},
		});
	} catch (error) {
		console.error("Failed to generate workflow:", error);
		return NextResponse.json(
			{
				error:
					error instanceof Error
						? error.message
						: "Failed to generate workflow",
			},
			{ status: 500 },
		);
	}
}
