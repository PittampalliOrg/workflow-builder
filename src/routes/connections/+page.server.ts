import { redirect } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';
import { getApplicationAdapters } from '$lib/server/application';

export const load: PageServerLoad = async ({ locals, url }) => {
	if (!locals.session?.projectId) {
		redirect(302, '/auth/sign-in');
	}

	const externalId = await getApplicationAdapters().workflowData.getWorkspaceProjectExternalId(
		locals.session.projectId,
	);
	const slug = externalId ?? locals.session.projectId;

	const suffix = url.search ? url.search : '';
	redirect(302, `/workspaces/${slug}/connections${suffix}`);
};
