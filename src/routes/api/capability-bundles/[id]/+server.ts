import { error, json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { getApplicationAdapters } from "$lib/server/application";

export const GET: RequestHandler = async ({ params, locals }) => {
	if (!locals.session?.userId) return error(401, "Authentication required");
	const bundle = await getApplicationAdapters().capabilityBundles.getBundle({
		id: params.id,
	});
	if (!bundle) return error(404, "Bundle not found");
	return json({ bundle });
};

export const PUT: RequestHandler = async ({ params, request, locals }) => {
	if (!locals.session?.userId) return error(401, "Authentication required");
	const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
	const bundle = await getApplicationAdapters().capabilityBundles.updateBundle({
		id: params.id,
		body,
		userId: locals.session.userId,
	});
	if (!bundle) return error(404, "Bundle not found");
	return json({ bundle });
};

export const DELETE: RequestHandler = async ({ params, locals }) => {
	if (!locals.session?.userId) return error(401, "Authentication required");
	const ok = await getApplicationAdapters().capabilityBundles.archiveBundle({
		id: params.id,
	});
	if (!ok) return error(404, "Bundle not found");
	return json({ ok: true });
};
