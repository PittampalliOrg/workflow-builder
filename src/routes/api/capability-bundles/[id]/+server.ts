import { error, json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import {
	archiveBundle,
	getBundle,
	updateBundle,
} from "$lib/server/capabilities/registry";
import type { CapabilityBundleConfig } from "$lib/types/agents";

export const GET: RequestHandler = async ({ params, locals }) => {
	if (!locals.session?.userId) return error(401, "Authentication required");
	const bundle = await getBundle(params.id);
	if (!bundle) return error(404, "Bundle not found");
	return json({ bundle });
};

export const PUT: RequestHandler = async ({ params, request, locals }) => {
	if (!locals.session?.userId) return error(401, "Authentication required");
	const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
	const bundle = await updateBundle(params.id, {
		name: typeof body.name === "string" ? body.name : undefined,
		description:
			typeof body.description === "string"
				? body.description
				: body.description === null
					? null
					: undefined,
		tags: Array.isArray(body.tags) ? body.tags.map(String) : undefined,
		config:
			body.config && typeof body.config === "object"
				? (body.config as CapabilityBundleConfig)
				: undefined,
		changelog: typeof body.changelog === "string" ? body.changelog : undefined,
		publishedBy: locals.session.userId,
	});
	if (!bundle) return error(404, "Bundle not found");
	return json({ bundle });
};

export const DELETE: RequestHandler = async ({ params, locals }) => {
	if (!locals.session?.userId) return error(401, "Authentication required");
	const ok = await archiveBundle(params.id);
	if (!ok) return error(404, "Bundle not found");
	return json({ ok: true });
};
