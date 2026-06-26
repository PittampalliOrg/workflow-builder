import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { db } from '$lib/server/db';
import { workflowExecutions } from '$lib/server/db/schema';
import { eq, inArray } from 'drizzle-orm';
import { isResourceInScope } from '$lib/server/workflows/project-scope';

/**
 * GET /api/workflows/executions/[executionId]/lineage
 *
 * The fork lineage TREE for a run: its rerun ancestors (walk `rerunOfExecutionId` up to
 * the root) PLUS all descendants (runs forked from it, recursively). Forks are
 * first-class — this powers the collapsible lineage tree on the run page + the canvas
 * run-picker so a user can see "run → fork@node → fork@node" branches and navigate them.
 *
 * Returns a flat node list (the client builds the tree) rooted at the lineage ROOT, each:
 *   { id, status, fromNodeId, parentId, startedAt, completedAt, durationMs, isCurrent }
 * `fromNodeId` is the node this branch forked from (NULL for the root / non-fork runs).
 *
 * Workspace-scoped: the requested run must be in the caller's scope; the lineage is then
 * confined to that workflow's runs.
 */

type LineageNode = {
	id: string;
	status: string | null;
	fromNodeId: string | null;
	parentId: string | null;
	startedAt: string | null;
	completedAt: string | null;
	durationMs: number | null;
	isCurrent: boolean;
};

export const GET: RequestHandler = async ({ params, locals }) => {
	if (!locals.session?.userId) return error(401, 'Authentication required');
	if (!db) return error(500, 'Database not available');

	// Scope check on the requested run (404 hides cross-workspace existence).
	const [self] = await db
		.select()
		.from(workflowExecutions)
		.where(eq(workflowExecutions.id, params.executionId))
		.limit(1);
	if (!self) return error(404, 'Execution not found');
	if (!isResourceInScope(self, locals.session)) return error(404, 'Execution not found');

	// 1. Walk up to the lineage ROOT (oldest ancestor with no rerun parent).
	let rootId = self.id;
	let cursor: string | null = self.rerunOfExecutionId ?? null;
	for (let hops = 0; hops < 50 && cursor; hops++) {
		const [parent]: Array<{ id: string; parent: string | null }> = await db
			.select({ id: workflowExecutions.id, parent: workflowExecutions.rerunOfExecutionId })
			.from(workflowExecutions)
			.where(eq(workflowExecutions.id, cursor))
			.limit(1);
		if (!parent) break;
		rootId = parent.id;
		cursor = parent.parent ?? null;
	}

	// 2. BFS down from the root collecting all descendants (the whole fork tree).
	const collected = new Map<
		string,
		{
			id: string;
			status: string | null;
			resumeFromNode: string | null;
			rerunOfExecutionId: string | null;
			startedAt: Date | null;
			completedAt: Date | null;
			duration: string | null;
		}
	>();
	let frontier: string[] = [rootId];
	for (let depth = 0; depth < 50 && frontier.length > 0; depth++) {
		const rows = await db
			.select({
				id: workflowExecutions.id,
				status: workflowExecutions.status,
				resumeFromNode: workflowExecutions.resumeFromNode,
				rerunOfExecutionId: workflowExecutions.rerunOfExecutionId,
				startedAt: workflowExecutions.startedAt,
				completedAt: workflowExecutions.completedAt,
				duration: workflowExecutions.duration
			})
			.from(workflowExecutions)
			.where(inArray(workflowExecutions.id, frontier));
		const next: string[] = [];
		for (const r of rows) {
			if (collected.has(r.id)) continue;
			collected.set(r.id, r);
			next.push(r.id);
		}
		if (next.length === 0) break;
		// Children: runs whose rerunOfExecutionId is one of the just-collected ids.
		const children = await db
			.select({ id: workflowExecutions.id })
			.from(workflowExecutions)
			.where(inArray(workflowExecutions.rerunOfExecutionId, next));
		frontier = children.map((c) => c.id).filter((id) => !collected.has(id));
	}

	const nodes: LineageNode[] = [...collected.values()].map((r) => {
		const durationMs =
			r.duration != null && r.duration !== ''
				? Number(r.duration)
				: r.completedAt && r.startedAt
					? r.completedAt.getTime() - r.startedAt.getTime()
					: null;
		return {
			id: r.id,
			status: r.status,
			fromNodeId: r.resumeFromNode ?? null,
			parentId: r.rerunOfExecutionId ?? null,
			startedAt: r.startedAt?.toISOString() ?? null,
			completedAt: r.completedAt?.toISOString() ?? null,
			durationMs: Number.isFinite(durationMs as number) ? (durationMs as number) : null,
			isCurrent: r.id === params.executionId
		};
	});

	return json({ rootId, currentId: params.executionId, nodes });
};
