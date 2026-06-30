/**
 * Cross-workflow execution listing scoped to a workspace.
 *
 * Powers `/workspaces/[slug]/runs`, the dashboard "Recent runs" card, and
 * the homepage "Recent runs" section. Unlike `/api/workflows/[workflowId]/
 * runs-summary` (which is per-workflow), `listRecentRuns` scans all runs in
 * the caller's current project and enriches each with workflow name,
 * spawned-session count, and the set of agents those sessions used.
 *
 * Uses the same two-select + in-memory-join pattern as `runs-summary` to
 * avoid an N+1 and to keep the query simple across drizzle's sparse joins.
 */
import {
	and,
	desc,
	eq,
	gte,
	ilike,
	inArray,
	isNull,
	or,
	type SQL,
} from "drizzle-orm";
import { db } from "$lib/server/db";
import {
	agents,
	sessions,
	workflowExecutions,
	workflows,
} from "$lib/server/db/schema";

export type RunStatus =
	| "pending"
	| "running"
	| "success"
	| "error"
	| "cancelled";

export type RunAgent = {
	id: string;
	name: string;
	avatar: string | null;
	slug: string | null;
};

export type RunSummary = {
	executionId: string;
	workflowId: string;
	workflowName: string;
	status: RunStatus;
	startedAt: string;
	completedAt: string | null;
	/** Duration in milliseconds. Derived server-side for completed runs;
	 *  `null` for still-running executions (UI computes wall-clock from
	 *  `startedAt`). */
	durationMs: number | null;
	sessionCount: number;
	agents: RunAgent[];
};

export type ListRunsFilter = {
	/** Required. Workspace scope. Without it we'd leak across workspaces. */
	projectId: string;
	workflowId?: string;
	status?: RunStatus;
	/** Only return runs whose `startedAt >= since`. */
	since?: Date;
	/** Case-insensitive fuzzy match on workflow name or execution id.
	 *  <2 chars → ignored (keeps index usable). */
	q?: string;
	/** Default 50; max 200. */
	limit?: number;
};

export async function listRecentRuns(
	filter: ListRunsFilter,
): Promise<RunSummary[]> {
	if (!db) throw new Error("Database not configured");
	const limit = Math.min(Math.max(filter.limit ?? 50, 1), 200);

	const conds: SQL[] = [
		or(
			eq(workflowExecutions.projectId, filter.projectId),
			isNull(workflowExecutions.projectId)
		) as SQL
	];
	if (filter.workflowId)
		conds.push(eq(workflowExecutions.workflowId, filter.workflowId));
	if (filter.status) conds.push(eq(workflowExecutions.status, filter.status));
	if (filter.since) conds.push(gte(workflowExecutions.startedAt, filter.since));
	if (filter.q && filter.q.trim().length >= 2) {
		const needle = `%${filter.q.trim()}%`;
		const textCond = or(
			ilike(workflows.name, needle),
			ilike(workflowExecutions.id, needle),
		);
		if (textCond) conds.push(textCond);
	}

	const execRows = await db
		.select({
			id: workflowExecutions.id,
			workflowId: workflowExecutions.workflowId,
			workflowName: workflows.name,
			status: workflowExecutions.status,
			startedAt: workflowExecutions.startedAt,
			completedAt: workflowExecutions.completedAt,
			duration: workflowExecutions.duration,
		})
		.from(workflowExecutions)
		.innerJoin(workflows, eq(workflows.id, workflowExecutions.workflowId))
		.where(and(...conds))
		.orderBy(desc(workflowExecutions.startedAt))
		.limit(limit);

	if (execRows.length === 0) return [];

	const execIds = execRows.map((r) => r.id);

	// Fetch spawned-session links for those executions (if any).
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
	const agentById = new Map<string, RunAgent>();
	if (agentIds.length > 0) {
		const rows = await db
			.select({
				id: agents.id,
				name: agents.name,
				avatar: agents.avatar,
				slug: agents.slug,
			})
			.from(agents)
			.where(inArray(agents.id, agentIds));
		for (const a of rows) {
			agentById.set(a.id, {
				id: a.id,
				name: a.name,
				avatar: a.avatar ?? null,
				slug: a.slug ?? null,
			});
		}
	}

	type Bucket = { sessionCount: number; agents: RunAgent[] };
	const byExec = new Map<string, Bucket>();
	for (const s of sessionRows) {
		if (!s.workflowExecutionId) continue;
		const bucket = byExec.get(s.workflowExecutionId) ?? {
			sessionCount: 0,
			agents: [],
		};
		bucket.sessionCount += 1;
		if (s.agentId) {
			const a = agentById.get(s.agentId);
			if (a && !bucket.agents.find((x) => x.id === a.id)) {
				bucket.agents.push(a);
			}
		}
		byExec.set(s.workflowExecutionId, bucket);
	}

	return execRows.map((e) => {
		const extras = byExec.get(e.id) ?? { sessionCount: 0, agents: [] };
		const durationMs = parseDurationMs(e.duration);
		return {
			executionId: e.id,
			workflowId: e.workflowId,
			workflowName: e.workflowName,
			status: e.status as RunStatus,
			startedAt: e.startedAt.toISOString(),
			completedAt: e.completedAt ? e.completedAt.toISOString() : null,
			durationMs,
			sessionCount: extras.sessionCount,
			agents: extras.agents,
		};
	});
}

/** `workflowExecutions.duration` is stored as a numeric string (milliseconds).
 *  Returns null for unparseable or absent values so the UI can pick wall-clock
 *  math for still-running executions. */
function parseDurationMs(value: string | null): number | null {
	if (!value) return null;
	const n = Number(value);
	return Number.isFinite(n) ? n : null;
}
