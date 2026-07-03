import { error, json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { getApplicationAdapters } from "$lib/server/application";

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
	const bundles = await getApplicationAdapters().capabilityBundles.listBundles({
		projectId,
		includeArchived,
	});
	return json({ bundles });
};

export const POST: RequestHandler = async ({ request, locals }) => {
	if (!locals.session?.userId) return error(401, "Authentication required");
	const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
	const bundle = await getApplicationAdapters().capabilityBundles.createBundle({
		body,
		userId: locals.session.userId,
		projectId: locals.session.projectId ?? null,
	});
	return json({ bundle }, { status: 201 });
};
