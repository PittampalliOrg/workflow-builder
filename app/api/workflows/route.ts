import { and, eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth-helpers";
import { db } from "@/lib/db";
import { workflows } from "@/lib/db/schema";
import {
	isSupportedWorkflowId,
	SUPPORTED_WORKFLOW_ID,
} from "@/lib/serverless-workflow/cutover";
import { extractPublishedRuntime } from "@/lib/workflow-publishing";

export async function GET(request: Request) {
	try {
		const session = await getSession(request);

		if (!session?.user) {
			return NextResponse.json([], { status: 200 });
		}

		const userWorkflows = await db
			.select()
			.from(workflows)
			.where(
				and(
					eq(workflows.userId, session.user.id),
					eq(workflows.id, SUPPORTED_WORKFLOW_ID),
				),
			);

		const mappedWorkflows = userWorkflows
			.filter((workflow) => isSupportedWorkflowId(workflow.id))
			.map((workflow) => ({
				...workflow,
				createdAt: workflow.createdAt.toISOString(),
				updatedAt: workflow.updatedAt.toISOString(),
				publishedRuntime: extractPublishedRuntime(
					(workflow as Record<string, unknown>).spec,
				),
			}));

		return NextResponse.json(mappedWorkflows);
	} catch (error) {
		console.error("Failed to get workflows:", error);
		return NextResponse.json(
			{
				error:
					error instanceof Error ? error.message : "Failed to get workflows",
			},
			{ status: 500 },
		);
	}
}
