import { error, json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { and, eq } from "drizzle-orm";
import { db } from "$lib/server/db";
import { projectMembers } from "$lib/server/db/schema";
import {
	SandboxProfileValidationError,
	archiveProfile,
	getProfile,
	updateProfile,
	type UpdateProfileInput,
} from "$lib/server/sandbox-profiles/registry";

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

export const GET: RequestHandler = async ({ params, locals }) => {
	if (!locals.session?.userId) return error(401, "Authentication required");
	const profile = await getProfile(params.id);
	if (!profile) return error(404, "Profile not found");
	return json({ profile });
};

export const PATCH: RequestHandler = async ({ params, request, locals }) => {
	if (!locals.session?.userId) return error(401, "Authentication required");
	await requireAdmin(locals.session.userId, locals.session.projectId ?? null);
	const body = (await request.json().catch(() => ({}))) as Record<
		string,
		unknown
	>;
	const input: UpdateProfileInput = {
		name: typeof body.name === "string" ? body.name : undefined,
		description:
			typeof body.description === "string" || body.description === null
				? (body.description as string | null)
				: undefined,
		baseProfileSlug:
			typeof body.baseProfileSlug === "string" || body.baseProfileSlug === null
				? (body.baseProfileSlug as string | null)
				: undefined,
		packages:
			body.packages && typeof body.packages === "object"
				? (body.packages as UpdateProfileInput["packages"])
				: undefined,
		capabilities: Array.isArray(body.capabilities)
			? body.capabilities.map(String)
			: undefined,
	};
	let profile;
	try {
		profile = await updateProfile(params.id, input);
	} catch (e) {
		if (e instanceof SandboxProfileValidationError) return error(400, e.message);
		throw e;
	}
	if (!profile) return error(404, "Profile not found");
	return json({ profile });
};

export const DELETE: RequestHandler = async ({ params, locals }) => {
	if (!locals.session?.userId) return error(401, "Authentication required");
	await requireAdmin(locals.session.userId, locals.session.projectId ?? null);
	const result = await archiveProfile(params.id);
	if (!result.archived) {
		// Disambiguate — not_found vs. policy block (builtin / in-use).
		if (result.reason === "not_found") return error(404, "Profile not found");
		return error(409, result.reason ?? "Cannot archive profile");
	}
	return json({ archived: true });
};
