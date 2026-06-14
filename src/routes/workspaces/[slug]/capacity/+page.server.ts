import { redirect } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';

/**
 * The Fleet section's default tab is the Active work list. Server-side
 * redirect keeps the URL canonical (back-button friendly, shareable).
 */
export const load: PageServerLoad = async ({ params }) => {
	throw redirect(307, `/workspaces/${params.slug}/capacity/active`);
};
