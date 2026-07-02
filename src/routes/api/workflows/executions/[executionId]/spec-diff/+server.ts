import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { createTwoFilesPatch } from 'diff';
import { getApplicationAdapters } from '$lib/server/application';
import { isResourceInScope } from '$lib/server/workflows/project-scope';
import { getTask, getTaskNames, type Spec } from '$lib/helpers/spec-mutations';

/**
 * GET /api/workflows/executions/[executionId]/spec-diff
 *
 * The per-branch spec diff: what NODES changed between a forked run and its parent.
 * Forks run a fresh copy of the (possibly edited) spec; each run snapshots the spec it
 * executed in `executionIr.spec` (start-run.ts), so we compare this run's spec against
 * its `rerunOfExecutionId` parent's. Returns a node-level summary (added/removed/changed)
 * + a unified diff per changed node — so a fork is self-explanatory ("changed: refine").
 *
 * `snapshotUnavailable` is true for runs created before spec snapshots were persisted.
 */

type SpecLike = Spec | null;

function specOf(executionIr: unknown): SpecLike {
	if (!executionIr || typeof executionIr !== 'object') return null;
	const spec = (executionIr as Record<string, unknown>).spec;
	return spec && typeof spec === 'object' ? (spec as Spec) : null;
}

function taskJson(spec: Spec, name: string): string {
	return JSON.stringify(getTask(spec, name) ?? {}, null, 2) + '\n';
}

export const GET: RequestHandler = async ({ params, locals }) => {
	if (!locals.session?.userId) return error(401, 'Authentication required');

	const workflowData = getApplicationAdapters().workflowData;
	const self = await workflowData.getExecutionById(params.executionId);
	if (!self) return error(404, 'Execution not found');
	if (!isResourceInScope(self, locals.session)) return error(404, 'Execution not found');

	const parentId = self.rerunOfExecutionId ?? null;
	if (!parentId) {
		return json({ hasParent: false, parentId: null, fromNode: self.resumeFromNode ?? null });
	}

	const parent = await workflowData.getExecutionById(parentId);

	const thisSpec = specOf(self.executionIr);
	const parentSpec = parent ? specOf(parent.executionIr) : null;
	if (!thisSpec || !parentSpec) {
		return json({
			hasParent: true,
			parentId,
			fromNode: self.resumeFromNode ?? null,
			snapshotUnavailable: true
		});
	}

	const parentNames = getTaskNames(parentSpec);
	const thisNames = getTaskNames(thisSpec);
	const parentSet = new Set(parentNames);
	const thisSet = new Set(thisNames);

	const added = thisNames.filter((n) => !parentSet.has(n));
	const removed = parentNames.filter((n) => !thisSet.has(n));
	const changed: Array<{ name: string; patch: string }> = [];
	for (const name of thisNames) {
		if (!parentSet.has(name)) continue;
		const before = taskJson(parentSpec, name);
		const after = taskJson(thisSpec, name);
		if (before === after) continue;
		changed.push({
			name,
			patch: createTwoFilesPatch(`${name} (parent)`, `${name} (this run)`, before, after, '', '')
		});
	}

	return json({
		hasParent: true,
		parentId,
		fromNode: self.resumeFromNode ?? null,
		snapshotUnavailable: false,
		added,
		removed,
		changed
	});
};
