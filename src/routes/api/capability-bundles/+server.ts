import { error, json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { createBundle, listBundles } from "$lib/server/capabilities/registry";
import type { CapabilityBundleConfig } from "$lib/types/agents";

export const GET: RequestHandler = async ({ url, locals }) => {
	if (!locals.session?.userId) return error(401, "Authentication required");
	const includeArchived = url.searchParams.get("includeArchived") === "true";
	const projectIdParam = url.searchParams.get("projectId");
	const projectId =
		projectIdParam === "null"
			? null
			: projectIdParam
				? projectIdParam
				: (locals.session.projectId ?? undefined);
	const bundles = await listBundles({ projectId, includeArchived });
	return json({ bundles });
};

export const POST: RequestHandler = async ({ request, locals }) => {
	if (!locals.session?.userId) return error(401, "Authentication required");
	const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
	const name =
		typeof body.name === "string" && body.name.trim() ? body.name.trim() : "Untitled bundle";
	const config = (
		body.config && typeof body.config === "object" ? body.config : {}
	) as CapabilityBundleConfig;
	const bundle = await createBundle({
		slug: typeof body.slug === "string" ? body.slug : undefined,
		name,
		description: typeof body.description === "string" ? body.description : null,
		tags: Array.isArray(body.tags) ? body.tags.map(String) : undefined,
		config,
		createdBy: locals.session.userId,
		projectId:
			typeof body.projectId === "string"
				? body.projectId
				: (locals.session.projectId ?? null),
	});
	return json({ bundle }, { status: 201 });
};
