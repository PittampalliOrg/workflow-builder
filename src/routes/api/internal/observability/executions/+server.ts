import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getApplicationAdapters } from '$lib/server/application';
import { validateInternalToken } from '$lib/server/internal-auth';
import { resolveInternalWorkflowPrincipal } from '../../workflow-mcp-principal';
import {
	decodePageCursor,
	encodePageCursor,
	pageCursorScope
} from './[executionId]/pagination';

const STATUSES = new Set(['pending', 'running', 'success', 'error', 'cancelled']);

/** Workspace-scoped execution discovery for Workflow MCP diagnostics. */
export const GET: RequestHandler = async ({ request, url }) => {
	if (!validateInternalToken(request)) throw error(401, 'Unauthorized');

	const app = getApplicationAdapters();
	const principalResult = await resolveInternalWorkflowPrincipal(
		request,
		app.internalWorkflowPrincipal,
		{ requiredScope: 'workflow:read' }
	);
	if (!principalResult.ok) throw error(principalResult.status, principalResult.error);

	const workflowId = url.searchParams.get('workflowId')?.trim() || undefined;
	const workflowName = url.searchParams.get('workflowName')?.trim() || undefined;
	if (workflowId && workflowName) {
		throw error(400, 'Provide workflowId or workflowName, not both');
	}

	let resolvedWorkflowId: string | undefined;
	if (workflowId) {
		const workflow = await app.workflowData.getScopedWorkflowById({
			workflowId,
			userId: principalResult.principal.userId,
			projectId: principalResult.principal.projectId
		});
		if (!workflow) throw error(404, 'Workflow not found');
		resolvedWorkflowId = workflow.id;
	} else if (workflowName) {
		const workflow = await app.workflowData.getScopedWorkflowByName({
			workflowName,
			userId: principalResult.principal.userId,
			projectId: principalResult.principal.projectId
		});
		if (!workflow) throw error(404, 'Workflow not found');
		resolvedWorkflowId = workflow.id;
	}

	const rawStatus = url.searchParams.get('status')?.trim() || undefined;
	if (rawStatus && !STATUSES.has(rawStatus)) throw error(400, 'Invalid execution status');
	const limit = Math.min(Math.max(Number(url.searchParams.get('limit')) || 20, 1), 100);
	const cursorScope = pageCursorScope('executions', {
		projectId: principalResult.principal.projectId,
		workflowId: resolvedWorkflowId ?? null,
		status: rawStatus ?? null,
		limit
	});
	const offset = decodePageCursor(url.searchParams.get('cursor'), cursorScope);
	if (offset == null) throw error(400, 'Invalid execution-list cursor');
	const rows = await app.workflowData.listProjectWorkflowRuns({
		projectId: principalResult.principal.projectId,
		workflowId: resolvedWorkflowId,
		status: rawStatus as 'pending' | 'running' | 'success' | 'error' | 'cancelled' | undefined,
		limit: limit + 1,
		offset
	});
	const hasMore = rows.length > limit;
	const executions = rows.slice(0, limit);

	return json({
		executions,
		page: {
			limit,
			count: executions.length,
			truncated: hasMore,
			nextCursor: hasMore ? encodePageCursor(offset + limit, cursorScope) : null
		},
		observedAt: new Date().toISOString()
	});
};
