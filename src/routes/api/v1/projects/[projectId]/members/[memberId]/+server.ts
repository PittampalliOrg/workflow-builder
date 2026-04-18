import { json, error } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { db } from "$lib/server/db";
import {
	projectMembers,
	type ProjectRole,
} from "$lib/server/db/schema";
import { and, eq } from "drizzle-orm";

const ROLES: readonly ProjectRole[] = ["ADMIN", "EDITOR", "OPERATOR", "VIEWER"];
function isRole(v: unknown): v is ProjectRole {
	return typeof v === "string" && (ROLES as readonly string[]).includes(v);
}

async function requireAdmin(userId: string, projectId: string): Promise<true> {
	if (!db) throw error(503, "Database not configured");
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
	return true;
}

async function countAdmins(projectId: string): Promise<number> {
	if (!db) return 0;
	const rows = await db
		.select({ id: projectMembers.id })
		.from(projectMembers)
		.where(
			and(
				eq(projectMembers.projectId, projectId),
				eq(projectMembers.role, "ADMIN"),
			),
		);
	return rows.length;
}

/**
 * PATCH /api/v1/projects/[projectId]/members/[memberId]
 * Body: { role }
 *
 * Change a member's role. Cannot demote the last remaining ADMIN.
 */
export const PATCH: RequestHandler = async ({ params, locals, request }) => {
	if (!db) return error(503, "Database not configured");
	if (!locals.session?.userId) return error(401, "Authentication required");
	await requireAdmin(locals.session.userId, params.projectId);

	const body = (await request.json().catch(() => ({}))) as Record<
		string,
		unknown
	>;
	if (!isRole(body.role)) {
		return error(400, `role must be one of ${ROLES.join(", ")}`);
	}

	const [existing] = await db
		.select()
		.from(projectMembers)
		.where(
			and(
				eq(projectMembers.id, params.memberId),
				eq(projectMembers.projectId, params.projectId),
			),
		)
		.limit(1);
	if (!existing) return error(404, "Member not found");

	if (existing.role === "ADMIN" && body.role !== "ADMIN") {
		const admins = await countAdmins(params.projectId);
		if (admins <= 1) return error(400, "Cannot demote the last admin");
	}

	const [updated] = await db
		.update(projectMembers)
		.set({ role: body.role, updatedAt: new Date() })
		.where(eq(projectMembers.id, params.memberId))
		.returning();

	return json({ member: updated });
};

/**
 * DELETE /api/v1/projects/[projectId]/members/[memberId]
 *
 * Remove a member from the project. Cannot remove the last remaining ADMIN.
 * Removing yourself is allowed as long as another admin exists.
 */
export const DELETE: RequestHandler = async ({ params, locals }) => {
	if (!db) return error(503, "Database not configured");
	if (!locals.session?.userId) return error(401, "Authentication required");
	await requireAdmin(locals.session.userId, params.projectId);

	const [existing] = await db
		.select()
		.from(projectMembers)
		.where(
			and(
				eq(projectMembers.id, params.memberId),
				eq(projectMembers.projectId, params.projectId),
			),
		)
		.limit(1);
	if (!existing) return error(404, "Member not found");

	if (existing.role === "ADMIN") {
		const admins = await countAdmins(params.projectId);
		if (admins <= 1) return error(400, "Cannot remove the last admin");
	}

	await db
		.delete(projectMembers)
		.where(eq(projectMembers.id, params.memberId));

	return json({ ok: true });
};
