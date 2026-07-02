import { json, error } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { getApplicationAdapters } from "$lib/server/application";

function serializeMember(member: {
	id: string;
	userId: string;
	name?: string | null;
	email?: string | null;
	image?: string | null;
	role: string;
	createdAt: Date;
}) {
	return {
		id: member.id,
		userId: member.userId,
		name: member.name ?? null,
		email: member.email ?? null,
		image: member.image ?? null,
		role: member.role,
		createdAt: member.createdAt.toISOString(),
	};
}

function mapAdapterError(err: unknown): never {
	if (err instanceof Error && err.message === "Database not configured") {
		throw error(503, "Database not configured");
	}
	throw err;
}

/**
 * GET /api/v1/projects/[projectId]/members
 *
 * List members of the project. Any member can read the member list.
 */
export const GET: RequestHandler = async ({ params, locals }) => {
	if (!locals.session?.userId) return error(401, "Authentication required");

	const result = await getApplicationAdapters()
		.workflowData.listProjectMembers({
			projectId: params.projectId,
			userId: locals.session.userId,
		})
		.catch(mapAdapterError);
	if (!result.ok) return error(result.status, result.message);

	return json({
		members: result.members.map(serializeMember),
		selfRole: result.selfRole,
	});
};

/**
 * POST /api/v1/projects/[projectId]/members
 *
 * Body: { email | userId, role }
 */
export const POST: RequestHandler = async ({ params, locals, request }) => {
	if (!locals.session?.userId) return error(401, "Authentication required");

	const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
	const result = await getApplicationAdapters()
		.workflowData.addProjectMember({
			projectId: params.projectId,
			userId: locals.session.userId,
			targetUserId: body.userId,
			email: body.email,
			role: body.role,
		})
		.catch(mapAdapterError);
	if (!result.ok) return error(result.status, result.message);

	return json({ member: result.member }, { status: result.status });
};
