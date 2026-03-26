import { and, eq, inArray } from "drizzle-orm";
import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth-helpers";
import { db } from "@/lib/db";
import { workflowExecutions, workflows } from "@/lib/db/schema";

export async function GET(request: Request) {
	try {
		const session = await getSession(request);
		if (!session) {
			return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
		}

		const activeStatuses = ["pending", "running"] as const;

		const executions = await db
			.select({
				id: workflowExecutions.id,
				workflowId: workflowExecutions.workflowId,
				workflowName: workflows.name,
				status: workflowExecutions.status,
				phase: workflowExecutions.phase,
			})
			.from(workflowExecutions)
			.innerJoin(workflows, eq(workflowExecutions.workflowId, workflows.id))
			.where(
				and(
					eq(workflowExecutions.userId, session.user.id),
					inArray(workflowExecutions.status, [...activeStatuses]),
				),
			)
			.limit(50);

		const result = executions.map((e) => ({
			id: e.id,
			workflowId: e.workflowId,
			workflowName: e.workflowName,
			status: e.status,
			phase: e.phase,
			approvalEventName: null,
		}));

		return NextResponse.json(result);
	} catch (error) {
		console.error("Failed to fetch active executions:", error);
		return NextResponse.json(
			{ error: "Internal server error" },
			{ status: 500 },
		);
	}
}
