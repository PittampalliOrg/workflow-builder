import { error, json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { createVault, listVaults } from "$lib/server/vaults/registry";

export const GET: RequestHandler = async ({ url, locals }) => {
	if (!locals.session?.userId) return error(401, "Authentication required");
	const q = url.searchParams.get("q") ?? undefined;
	const includeArchived = url.searchParams.get("includeArchived") === "true";
	const projectIdParam = url.searchParams.get("projectId");
	const projectId =
		projectIdParam === "null"
			? null
			: projectIdParam === null
				? undefined
				: projectIdParam;
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
