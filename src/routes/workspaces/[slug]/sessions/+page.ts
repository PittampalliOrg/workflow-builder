import { redirect } from '@sveltejs/kit';
import type { PageLoad } from './$types';

/**
 * The standalone Sessions list is folded into the Fleet (Phase 1 Observe-hub
 * consolidation) — the Fleet's "Sessions" lens is a superset (live activity +
 * resource usage + bulk controls). Redirect here, preserving common filters.
 * Session DETAIL pages (/sessions/[id]) and /sessions/new are unaffected.
 */
export const load: PageLoad = ({ params, url }) => {
	const target = new URL(`/workspaces/${params.slug}/capacity/active`, url.origin);
	target.searchParams.set('kind', 'session');
	target.searchParams.set('scope', 'all');
	const q = url.searchParams.get('q');
	if (q) target.searchParams.set('q', q);
	redirect(307, `${target.pathname}${target.search}`);
};
