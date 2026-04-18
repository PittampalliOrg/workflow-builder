import { redirect } from "@sveltejs/kit";
import type { PageServerLoad } from "./$types";
import { db } from "$lib/server/db";
import { projects, projectMembers } from "$lib/server/db/schema";
import { eq, and } from "drizzle-orm";

export const load: PageServerLoad = async ({ locals }) => {
	if (!locals.session?.userId) throw redirect(303, "/auth/sign-in");
	if (!db || !locals.session.projectId) {
		return { activeProject: null };
	}

	const [project] = await db
		.select({
			id: projects.id,
			displayName: projects.displayName,
			externalId: projects.externalId,
		})
		.from(projects)
		.where(eq(projects.id, locals.session.projectId))
		.limit(1);

	if (!project) return { activeProject: null };

	const [self] = await db
		.select({ role: projectMembers.role })
		.from(projectMembers)
		.where(
			and(
				eq(projectMembers.projectId, project.id),
				eq(projectMembers.userId, locals.session.userId),
			),
		)
		.limit(1);

	return {
		activeProject: {
			id: project.id,
			displayName: project.displayName,
			externalId: project.externalId,
			selfRole: self?.role ?? null,
		},
	};
};
