import { redirect } from '@sveltejs/kit';
import type { PageLoad } from './$types';

/**
 * The standalone Runs list is folded into the Fleet (Phase 1 Observe-hub
 * consolidation) — the Fleet's "Workflows" lens shows the same executions with
 * live activity + resource usage. Redirect here, preserving the search filter.
 */
export const load: PageLoad = ({ params, url }) => {
	const target = new URL(`/workspaces/${params.slug}/capacity/active`, url.origin);
	target.searchParams.set('kind', 'workflow');
	target.searchParams.set('scope', 'all');
	const q = url.searchParams.get('q');
	if (q) target.searchParams.set('q', q);
	// Forward the editor's deep-link so the Fleet pins to one workflow's runs.
	const workflowId = url.searchParams.get('workflowId');
	if (workflowId) target.searchParams.set('workflowId', workflowId);
	redirect(307, `${target.pathname}${target.search}`);
};
