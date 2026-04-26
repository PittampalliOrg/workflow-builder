import { redirect } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';
import { db } from '$lib/server/db';
import { projects } from '$lib/server/db/schema';
import { eq } from 'drizzle-orm';

export const load: PageServerLoad = async ({ locals, url }) => {
	if (!locals.session?.projectId) {
		redirect(302, '/auth/sign-in');
	}

	let slug = locals.session.projectId;
	if (db) {
		const [project] = await db
			.select({ externalId: projects.externalId })
			.from(projects)
			.where(eq(projects.id, locals.session.projectId))
			.limit(1);
		if (project?.externalId) slug = project.externalId;
	}

	const suffix = url.search ? url.search : '';
	redirect(302, `/workspaces/${slug}/connections${suffix}`);
};
