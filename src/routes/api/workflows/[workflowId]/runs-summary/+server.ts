import { json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { db } from "$lib/server/db";
import { agents, sessions, workflowExecutions } from "$lib/server/db/schema";
import { eq, desc, inArray } from "drizzle-orm";

/**
 * GET /api/workflows/[workflowId]/runs-summary?limit=20
 *
 * Like /executions, but enriches each run with the set of bridge-spawned
 * sessions and the agents those sessions used. Drives the Agent + Session
 * columns on the workflow Runs tab. Computes in two selects + an in-memory
 * join so we don't need drizzle's leftJoin on a sparse relation.
 */
export const GET: RequestHandler = async ({ params, url }) => {
	const { workflowId } = params;
	const limit = parseInt(url.searchParams.get("limit") || "20");

	if (!db) return json({ executions: [] });

	try {
		const execRows = await db
			.select({
				id: workflowExecutions.id,
				workflowId: workflowExecutions.workflowId,
				status: workflowExecutions.status,
				startedAt: workflowExecutions.startedAt,
				completedAt: workflowExecutions.completedAt,
				duration: workflowExecutions.duration,
			})
			.from(workflowExecutions)
			.where(eq(workflowExecutions.workflowId, workflowId))
			.orderBy(desc(workflowExecutions.startedAt))
			.limit(limit);

		const execIds = execRows.map((r) => r.id).filter(Boolean);
		if (execIds.length === 0) return json({ executions: [] });

		const sessionRows = await db
			.select({
				id: sessions.id,
				workflowExecutionId: sessions.workflowExecutionId,
				agentId: sessions.agentId,
			})
			.from(sessions)
			.where(inArray(sessions.workflowExecutionId, execIds));

		const agentIds = Array.from(
			new Set(sessionRows.map((s) => s.agentId).filter((v): v is string => !!v)),
		);
		const agentNameById = new Map<string, string>();
		if (agentIds.length > 0) {
			const agentRows = await db
				.select({ id: agents.id, name: agents.name })
				.from(agents)
				.where(inArray(agents.id, agentIds));
			for (const a of agentRows) agentNameById.set(a.id, a.name);
		}

		const byExec = new Map<
			string,
			{ sessionIds: string[]; agents: { id: string; name: string }[] }
		>();
		for (const s of sessionRows) {
			const execId = s.workflowExecutionId;
			if (!execId) continue;
			const bucket = byExec.get(execId) ?? { sessionIds: [], agents: [] };
			bucket.sessionIds.push(s.id);
			if (s.agentId && !bucket.agents.find((a) => a.id === s.agentId)) {
				bucket.agents.push({
					id: s.agentId,
					name: agentNameById.get(s.agentId) ?? s.agentId,
				});
			}
			byExec.set(execId, bucket);
		}

		const enriched = execRows.map((e) => {
			const extras = byExec.get(e.id) ?? { sessionIds: [], agents: [] };
			return {
				id: e.id,
				workflowId: e.workflowId,
				status: e.status,
				startedAt: e.startedAt,
				completedAt: e.completedAt,
				duration: e.duration,
				sessionIds: extras.sessionIds,
				agents: extras.agents,
			};
		});

		return json({ executions: enriched });
	} catch (err) {
		console.error(
			`[runs-summary] error for workflow ${workflowId}:`,
			err,
		);
		return json({ executions: [] });
	}
};
