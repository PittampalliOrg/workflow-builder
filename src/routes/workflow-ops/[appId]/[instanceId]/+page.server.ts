import { redirect } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ params, url }) => {
	const suffix = url.pathname.endsWith('/history')
		? '/history'
		: url.pathname.endsWith('/relationships')
			? '/relationships'
			: '';
	redirect(307, `/workflow-ops/instances/${encodeURIComponent(params.instanceId)}${suffix}`);
};
