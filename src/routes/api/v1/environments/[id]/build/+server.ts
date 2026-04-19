import { error, json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { and, eq } from "drizzle-orm";
import { db } from "$lib/server/db";
import { projectMembers } from "$lib/server/db/schema";
import { triggerEnvironmentBuild } from "$lib/server/environments/builder";
import {
	getBaseImageResolver,
	getEnvironment,
} from "$lib/server/environments/registry";

async function requireAdmin(
	userId: string,
	projectId: string | null,
): Promise<void> {
	if (!db) throw error(503, "Database not configured");
	// Builtin envs are workspace-agnostic (project_id NULL). Admins of the
	// current workspace can trigger their rebuild — the alternative would be
	// a global "superadmin" role we don't have.
	if (!projectId) throw error(403, "Forbidden");
	const [row] = await db
		.select({ role: projectMembers.role })
		.from(projectMembers)
		.where(
			and(
				eq(projectMembers.userId, userId),
				eq(projectMembers.projectId, projectId),
			),
		)
		.limit(1);
	if (!row || row.role !== "ADMIN") throw error(403, "Forbidden");
}

export const POST: RequestHandler = async ({ params, locals }) => {
	if (!locals.session?.userId) return error(401, "Authentication required");
	await requireAdmin(locals.session.userId, locals.session.projectId ?? null);

	const env = await getEnvironment(params.id);
	if (!env) return error(404, "Environment not found");

	const resolver = await getBaseImageResolver();

	try {
		const result = await triggerEnvironmentBuild(env.id, resolver);
		return json({
			ok: true,
			commitSha: result.commitSha,
			dockerfilePath: result.dockerfilePath,
			imageTag: result.imageTag,
		});
	} catch (e) {
		const message = e instanceof Error ? e.message : String(e);
		return error(500, `Build trigger failed: ${message}`);
	}
};
