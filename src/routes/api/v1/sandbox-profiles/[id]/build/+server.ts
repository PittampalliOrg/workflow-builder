import { error, json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { and, eq } from "drizzle-orm";
import { db } from "$lib/server/db";
import { projectMembers } from "$lib/server/db/schema";
import { triggerProfileBuild } from "$lib/server/sandbox-profiles/builder";
import { getProfile, listProfiles } from "$lib/server/sandbox-profiles/registry";

async function requireAdmin(
	userId: string,
	projectId: string | null,
): Promise<void> {
	if (!db) throw error(503, "Database not configured");
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

	const profile = await getProfile(params.id);
	if (!profile) return error(404, "Profile not found");

	// Build a resolver that maps baseProfileSlug → current imageTag from the
	// profile catalog. Needed so the generated Dockerfile FROMs the parent's
	// concrete SHA-pinned tag rather than a stale `:latest` reference.
	const all = await listProfiles({ includeArchived: false });
	const bySlug = new Map(all.map((p) => [p.slug, p]));
	const resolver = (slug: string) => bySlug.get(slug)?.imageTag ?? undefined;

	try {
		const result = await triggerProfileBuild(profile.id, resolver);
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
