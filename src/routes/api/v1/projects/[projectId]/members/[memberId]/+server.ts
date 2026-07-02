import { json, error } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { getApplicationAdapters } from "$lib/server/application";

function mapAdapterError(err: unknown): never {
	if (err instanceof Error && err.message === "Database not configured") {
		throw error(503, "Database not configured");
	}
	throw err;
}

/**
 * PATCH /api/v1/projects/[projectId]/members/[memberId]
 * Body: { role }
 */
export const PATCH: RequestHandler = async ({ params, locals, request }) => {
	if (!locals.session?.userId) return error(401, "Authentication required");

	const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
	const result = await getApplicationAdapters()
		.workflowData.updateProjectMemberRole({
			projectId: params.projectId,
			memberId: params.memberId,
			userId: locals.session.userId,
			role: body.role,
		})
		.catch(mapAdapterError);
	if (!result.ok) return error(result.status, result.message);

	return json({ member: result.member });
};

/**
 * DELETE /api/v1/projects/[projectId]/members/[memberId]
 */
export const DELETE: RequestHandler = async ({ params, locals }) => {
	if (!locals.session?.userId) return error(401, "Authentication required");

	const result = await getApplicationAdapters()
		.workflowData.deleteProjectMember({
			projectId: params.projectId,
			memberId: params.memberId,
			userId: locals.session.userId,
		})
		.catch(mapAdapterError);
	if (!result.ok) return error(result.status, result.message);

	return json({ ok: true });
};
