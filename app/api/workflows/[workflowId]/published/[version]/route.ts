import { and, eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth-helpers";
import { db } from "@/lib/db";
import { workflows } from "@/lib/db/schema";
import {
	extractPublishedRuntime,
	resolvePublishedRevision,
	sanitizePublishedRevisions,
} from "@/lib/workflow-publishing";
import type { WorkflowSpec } from "@/lib/workflow-spec/types";

export async function GET(
	request: Request,
	context: { params: Promise<{ workflowId: string; version: string }> },
) {
	try {
		const { workflowId, version } = await context.params;
		const session = await getSession(request);

		if (!session?.user) {
			return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
		}

		const workflow = await db.query.workflows.findFirst({
			where: and(
				eq(workflows.id, workflowId),
				eq(workflows.userId, session.user.id),
			),
		});

		if (!workflow) {
			return NextResponse.json(
				{ error: "Workflow not found" },
				{ status: 404 },
			);
		}

		const spec =
			((workflow as Record<string, unknown>).spec as
				| WorkflowSpec
				| Record<string, unknown>
				| null
				| undefined) ?? null;
		const publishedRuntime = extractPublishedRuntime(spec);

		if (!publishedRuntime) {
			return NextResponse.json(
				{ error: "Workflow has not been published" },
				{ status: 404 },
			);
		}

		const revision = resolvePublishedRevision(publishedRuntime, version);
		if (!revision) {
			return NextResponse.json(
				{ error: "Published workflow revision not found" },
				{ status: 404 },
			);
		}

		return NextResponse.json({
			workflowId: workflow.id,
			workflowName: workflow.name,
			daprWorkflowName:
				workflow.daprWorkflowName ?? publishedRuntime.workflowName,
			latestVersion: publishedRuntime.latestVersion,
			requestedVersion: version,
			revision,
			revisions: sanitizePublishedRevisions(publishedRuntime.revisions).map(
				(entry) => ({
					version: entry.version,
					publishedAt: entry.publishedAt,
					specVersion: entry.specVersion ?? null,
				}),
			),
		});
	} catch (error) {
		console.error("Failed to load published workflow revision:", error);
		return NextResponse.json(
			{
				error:
					error instanceof Error
						? error.message
						: "Failed to load published workflow revision",
			},
			{ status: 500 },
		);
	}
}
