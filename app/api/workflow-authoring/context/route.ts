import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth-helpers";
import { getWorkflowAuthoringContext } from "@/lib/ai/workflow-authoring/context";
import type {
	WorkflowGenerationComplexity,
	WorkflowGenerationInput,
} from "@/lib/ai/workflow-authoring/types";

function parseBoolean(value: string | null): boolean | undefined {
	if (value === "true") {
		return true;
	}
	if (value === "false") {
		return false;
	}
	return undefined;
}

function parseComplexity(
	value: string | null,
): WorkflowGenerationComplexity | undefined {
	if (value === "simple" || value === "standard" || value === "multi_agent") {
		return value;
	}
	return undefined;
}

export async function GET(request: Request) {
	try {
		const session = await getSession(request);
		if (!session?.user) {
			return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
		}

		const { searchParams } = new URL(request.url);
		const issueNumberRaw = searchParams.get("issueNumber");
		const issueNumber =
			typeof issueNumberRaw === "string" && issueNumberRaw.trim().length > 0
				? Number.parseInt(issueNumberRaw, 10)
				: undefined;
		const generation: WorkflowGenerationInput = {
			prompt: searchParams.get("prompt") ?? "",
			complexity: parseComplexity(searchParams.get("complexity")),
			requiresPullRequest: parseBoolean(
				searchParams.get("requiresPullRequest"),
			),
			preferAvailableMcp: parseBoolean(searchParams.get("preferAvailableMcp")),
			repoOwner: searchParams.get("repoOwner") ?? undefined,
			repoName: searchParams.get("repoName") ?? undefined,
			issueNumber: Number.isFinite(issueNumber) ? issueNumber : undefined,
		};

		const context = await getWorkflowAuthoringContext({
			projectId: session.user.projectId,
			generation,
		});
		return NextResponse.json(context);
	} catch (error) {
		console.error("Failed to load workflow authoring context:", error);
		return NextResponse.json(
			{
				error:
					error instanceof Error
						? error.message
						: "Failed to load workflow authoring context",
			},
			{ status: 500 },
		);
	}
}
