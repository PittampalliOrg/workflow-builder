import { error, json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { and, eq } from "drizzle-orm";
import { db } from "$lib/server/db";
import { projectMembers } from "$lib/server/db/schema";
import {
	SandboxProfileValidationError,
	createProfile,
	listProfiles,
	type CreateProfileInput,
} from "$lib/server/sandbox-profiles/registry";

/**
 * Admin-gating: only workspace admins can mutate sandbox-profile rows. Reads
 * are available to anyone in the workspace so the env editor's dropdown can
 * hydrate. Mirrors the pattern from project members.
 */
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

export const GET: RequestHandler = async ({ url, locals }) => {
	if (!locals.session?.userId) return error(401, "Authentication required");
	const includeArchived = url.searchParams.get("includeArchived") === "true";
	const profiles = await listProfiles({ includeArchived });
	return json({ profiles });
};

export const POST: RequestHandler = async ({ request, locals }) => {
	if (!locals.session?.userId) return error(401, "Authentication required");
	await requireAdmin(locals.session.userId, locals.session.projectId ?? null);
	const body = (await request.json().catch(() => ({}))) as Record<
		string,
		unknown
	>;
	const input: CreateProfileInput = {
		slug: typeof body.slug === "string" ? body.slug : "",
		name:
			typeof body.name === "string" && body.name.trim()
				? body.name.trim()
				: "",
		description:
			typeof body.description === "string" ? body.description : null,
		baseProfileSlug:
			typeof body.baseProfileSlug === "string"
				? body.baseProfileSlug
				: null,
		packages:
			body.packages && typeof body.packages === "object"
				? (body.packages as CreateProfileInput["packages"])
				: undefined,
		capabilities: Array.isArray(body.capabilities)
			? body.capabilities.map(String)
			: undefined,
		createdBy: locals.session.userId,
		projectId: locals.session.projectId ?? null,
	};
	if (!input.slug || !input.name) {
		return error(400, "slug and name are required");
	}
	let profile;
	try {
		profile = await createProfile(input);
	} catch (e) {
		if (e instanceof SandboxProfileValidationError) return error(400, e.message);
		throw e;
	}
	return json({ profile }, { status: 201 });
};
