import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth-helpers";
import {
	repairWorkflowDefinitionShape,
	validateWorkflowDefinition,
} from "@/lib/serverless-workflow/sdk";

export async function POST(request: Request) {
	try {
		const session = await getSession(request);
		if (!session?.user) {
			return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
		}

		const body = (await request.json().catch(() => ({}))) as {
			spec?: unknown;
		};
		const repaired = repairWorkflowDefinitionShape(body.spec);
		return NextResponse.json({
			spec: repaired.workflow,
			repairActions: repaired.actions,
			issues: validateWorkflowDefinition(repaired.workflow),
		});
	} catch (error) {
		console.error("Failed to repair workflow authoring spec:", error);
		return NextResponse.json(
			{
				error:
					error instanceof Error
						? error.message
						: "Failed to repair workflow authoring spec",
			},
			{ status: 500 },
		);
	}
}
