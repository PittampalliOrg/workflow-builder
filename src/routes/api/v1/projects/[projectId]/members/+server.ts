import { json, error } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { db } from "$lib/server/db";
import {
	projects,
	projectMembers,
	users,
	type ProjectRole,
} from "$lib/server/db/schema";
import { and, asc, eq } from "drizzle-orm";

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

async function assertSamePlatform(
	userId: string,
	projectId: string,
): Promise<void> {
	if (!db) throw error(503, "Database not configured");
	const [project] = await db
		.select({ platformId: projects.platformId })
		.from(projects)
		.where(eq(projects.id, projectId))
		.limit(1);
	if (!project) throw error(404, "Project not found");
	const [user] = await db
		.select({ platformId: users.platformId })
		.from(users)
		.where(eq(users.id, userId))
		.limit(1);
	if (!user || user.platformId !== project.platformId) {
		throw error(403, "User is not part of this platform");
	}
}

/**
 * GET /api/v1/projects/[projectId]/members
 *
 * List members of the project. Any member can read the member list.
 */
export const GET: RequestHandler = async ({ params, locals }) => {
	if (!db) return error(503, "Database not configured");
	if (!locals.session?.userId) return error(401, "Authentication required");

	const [self] = await db
		.select({ role: projectMembers.role })
		.from(projectMembers)
		.where(
			and(
				eq(projectMembers.projectId, params.projectId),
				eq(projectMembers.userId, locals.session.userId),
			),
		)
		.limit(1);
	if (!self) return error(403, "Forbidden");

	const rows = await db
		.select({
			id: projectMembers.id,
			userId: users.id,
			name: users.name,
			email: users.email,
			image: users.image,
			role: projectMembers.role,
			createdAt: projectMembers.createdAt,
		})
		.from(projectMembers)
		.innerJoin(users, eq(users.id, projectMembers.userId))
		.where(eq(projectMembers.projectId, params.projectId))
		.orderBy(asc(projectMembers.createdAt));

	return json({
		members: rows.map((r) => ({
			id: r.id,
			userId: r.userId,
			name: r.name ?? null,
			email: r.email ?? null,
			image: r.image ?? null,
			role: r.role,
			createdAt: r.createdAt.toISOString(),
		})),
		selfRole: self.role,
	});
};

/**
 * POST /api/v1/projects/[projectId]/members
 *
 * Body: { email | userId, role }
 *
 * Adds an existing platform user to the project. Creating brand-new users
 * requires signup (OAuth/email), so this endpoint only binds existing users.
 */
export const POST: RequestHandler = async ({ params, locals, request }) => {
	if (!db) return error(503, "Database not configured");
	if (!locals.session?.userId) return error(401, "Authentication required");
	await requireAdmin(locals.session.userId, params.projectId);

	const body = (await request.json().catch(() => ({}))) as Record<
		string,
		unknown
	>;
	const role: ProjectRole = isRole(body.role) ? body.role : "VIEWER";

	let targetUserId: string | null = null;
	if (typeof body.userId === "string" && body.userId.trim()) {
		targetUserId = body.userId.trim();
	} else if (typeof body.email === "string" && body.email.trim()) {
		const [u] = await db
			.select({ id: users.id })
			.from(users)
			.where(eq(users.email, body.email.trim().toLowerCase()))
			.limit(1);
		if (!u) return error(404, "No user with that email. Ask them to sign up first.");
		targetUserId = u.id;
	} else {
		return error(400, "email or userId is required");
	}

	await assertSamePlatform(targetUserId, params.projectId);

	const [existing] = await db
		.select({ id: projectMembers.id })
		.from(projectMembers)
		.where(
			and(
				eq(projectMembers.projectId, params.projectId),
				eq(projectMembers.userId, targetUserId),
			),
		)
		.limit(1);
	if (existing) return error(409, "User is already a member");

	const [inserted] = await db
		.insert(projectMembers)
		.values({
			projectId: params.projectId,
			userId: targetUserId,
			role,
		})
		.returning();

	return json({ member: inserted }, { status: 201 });
};
