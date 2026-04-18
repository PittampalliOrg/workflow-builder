import { and, eq } from "drizzle-orm";
import { db } from "$lib/server/db";
import { projects, projectMembers } from "$lib/server/db/schema";
import { generateId } from "$lib/server/utils/id";

function requireDb() {
	if (!db) throw new Error("Database not configured");
	return db;
}

export type WorkspaceSummary = {
	id: string;
	displayName: string;
	externalId: string;
	slug: string;
	role: "ADMIN" | "MEMBER";
	isCurrent: boolean;
	createdAt: string;
};

export type ListWorkspacesInput = {
	userId: string;
	currentProjectId: string;
};

/**
 * Every project the user is a member of. Shape mirrors the CMA workspace
 * list exactly (`slug`, `displayName`, role, is-current flag) so the
 * sidebar + /workspaces page can render from one source.
 */
export async function listWorkspaces(
	input: ListWorkspacesInput,
): Promise<WorkspaceSummary[]> {
	const database = requireDb();
	const rows = await database
		.select({
			id: projects.id,
			displayName: projects.displayName,
			externalId: projects.externalId,
			role: projectMembers.role,
			createdAt: projects.createdAt,
		})
		.from(projects)
		.innerJoin(
			projectMembers,
			and(
				eq(projectMembers.projectId, projects.id),
				eq(projectMembers.userId, input.userId),
			),
		)
		.orderBy(projects.createdAt);
	return rows.map((r) => ({
		id: r.id,
		displayName: r.displayName,
		externalId: r.externalId,
		slug: r.id === input.currentProjectId ? "default" : r.externalId,
		role: r.role as "ADMIN" | "MEMBER",
		isCurrent: r.id === input.currentProjectId,
		createdAt: r.createdAt.toISOString(),
	}));
}

export type CreateWorkspaceInput = {
	displayName: string;
	externalId?: string;
	userId: string;
	platformId: string;
};

/**
 * Create a new project and add the caller as its ADMIN. externalId is the
 * slug visible in URLs — auto-generated from displayName when not provided.
 * AP-compatible: the external_id unique constraint means callers don't
 * accidentally collide with pre-existing AP workspace ids.
 */
export async function createWorkspace(
	input: CreateWorkspaceInput,
): Promise<WorkspaceSummary> {
	const database = requireDb();
	const externalId = (input.externalId || slugify(input.displayName)).slice(0, 60);
	const [row] = await database
		.insert(projects)
		.values({
			platformId: input.platformId,
			ownerId: input.userId,
			displayName: input.displayName,
			externalId,
		})
		.returning();
	await database.insert(projectMembers).values({
		projectId: row.id,
		userId: input.userId,
		role: "ADMIN",
	});
	return {
		id: row.id,
		displayName: row.displayName,
		externalId: row.externalId,
		slug: row.externalId,
		role: "ADMIN",
		isCurrent: false,
		createdAt: row.createdAt.toISOString(),
	};
}

/**
 * Rename a project. Only the caller's ADMIN membership is checked; we do
 * not support renaming externalId (the URL slug) because too many rows
 * point at it via project_id FKs that propagate elsewhere.
 */
export async function renameWorkspace(
	projectId: string,
	userId: string,
	displayName: string,
): Promise<boolean> {
	const database = requireDb();
	const [member] = await database
		.select({ role: projectMembers.role })
		.from(projectMembers)
		.where(
			and(
				eq(projectMembers.projectId, projectId),
				eq(projectMembers.userId, userId),
			),
		)
		.limit(1);
	if (member?.role !== "ADMIN") return false;
	const [row] = await database
		.update(projects)
		.set({ displayName, updatedAt: new Date() })
		.where(eq(projects.id, projectId))
		.returning({ id: projects.id });
	return Boolean(row);
}

function slugify(name: string): string {
	return (
		name
			.trim()
			.toLowerCase()
			.replace(/[^a-z0-9-]+/g, "-")
			.replace(/^-+|-+$/g, "")
			.slice(0, 40) + "-" + generateId().slice(0, 8)
	);
}
