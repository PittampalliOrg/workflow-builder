import { and, asc, eq, isNull, or } from "drizzle-orm";
import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth-helpers";
import { db } from "@/lib/db";
import { workflows } from "@/lib/db/schema";
import type { ObservabilityEntitiesResponse } from "@/lib/types/observability";

export const dynamic = "force-dynamic";

function projectWorkflowScope(projectId: string, userId: string) {
	return or(
		eq(workflows.projectId, projectId),
		and(isNull(workflows.projectId), eq(workflows.userId, userId)),
	);
}

export async function GET(request: Request) {
	try {
		const session = await getSession(request);

		if (!session?.user) {
			return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
		}

		const rows = await db
			.select({
				id: workflows.id,
				name: workflows.name,
			})
			.from(workflows)
			.where(projectWorkflowScope(session.user.projectId, session.user.id))
			.orderBy(asc(workflows.name))
			.limit(500);

		const entities: ObservabilityEntitiesResponse["entities"] = rows.map(
			(workflow) => ({
				id: workflow.id,
				name: workflow.name,
				type: "workflow",
			}),
		);

		return NextResponse.json<ObservabilityEntitiesResponse>({ entities });
	} catch (error) {
		console.error("Failed to list observability entities:", error);
		return NextResponse.json(
			{ error: "Failed to list observability entities" },
			{ status: 500 },
		);
	}
}
