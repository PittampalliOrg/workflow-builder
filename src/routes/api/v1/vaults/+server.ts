import { error, json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { createVault, listVaults } from "$lib/server/vaults/registry";

export const GET: RequestHandler = async ({ url, locals }) => {
	if (!locals.session?.userId) return error(401, "Authentication required");
	const q = url.searchParams.get("q") ?? undefined;
	const includeArchived = url.searchParams.get("includeArchived") === "true";
	const projectIdParam = url.searchParams.get("projectId");
	// Default to the caller's active workspace projectId (set by the
	// X-Workspace header hook), so the vaults list follows the current
	// URL's workspace instead of showing cross-workspace rows. Explicit
	// `?projectId=null` still returns org-shared vaults; explicit
	// `?projectId=<id>` scopes to that project.
	const projectId =
		projectIdParam === "null"
			? null
			: projectIdParam
				? projectIdParam
				: locals.session.projectId;
	const vaults = await listVaults({ q, includeArchived, projectId });
	return json({ vaults });
};

export const POST: RequestHandler = async ({ request, locals }) => {
	if (!locals.session?.userId) return error(401, "Authentication required");
	const body = (await request.json().catch(() => ({}))) as Record<
		string,
		unknown
	>;
	const name = typeof body.name === "string" && body.name.trim() ? body.name.trim() : "";
	if (!name) return error(400, "name is required");
	const vault = await createVault({
		name,
		description: typeof body.description === "string" ? body.description : null,
		projectId: typeof body.projectId === "string" ? body.projectId : null,
		createdBy: locals.session.userId,
	});
	return json({ vault }, { status: 201 });
};
