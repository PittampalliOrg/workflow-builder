import { redirect } from '@sveltejs/kit';
import type { PageLoad } from './$types';

/**
 * /cost merged into the "Cost & Usage" page (Phase 1 Observe-hub consolidation).
 * Redirect to /usage?tab=cost, preserving the optional api_key filter.
 */
export const load: PageLoad = ({ params, url }) => {
	const target = new URL(`/workspaces/${params.slug}/usage`, url.origin);
	target.searchParams.set('tab', 'cost');
	const apiKey = url.searchParams.get('api_key');
	if (apiKey) target.searchParams.set('api_key', apiKey);
	redirect(307, `${target.pathname}${target.search}`);
};
