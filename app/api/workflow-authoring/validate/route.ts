import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth-helpers";
import { validateWorkflowDefinition } from "@/lib/serverless-workflow/sdk";

export async function POST(request: Request) {
	try {
		const session = await getSession(request);
		if (!session?.user) {
			return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
		}

		const body = (await request.json().catch(() => ({}))) as {
			spec?: unknown;
		};
		const issues = validateWorkflowDefinition(body.spec);
		return NextResponse.json({
			valid: issues.length === 0,
			issues,
		});
	} catch (error) {
		console.error("Failed to validate workflow authoring spec:", error);
		return NextResponse.json(
			{
				error:
					error instanceof Error
						? error.message
						: "Failed to validate workflow authoring spec",
			},
			{ status: 500 },
		);
	}
}
