import { error, json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { getApplicationAdapters } from "$lib/server/application";
import { safePreviewName } from "$lib/types/dev-previews";

/** List Tier-2 (vcluster full-isolation) previews + A3/A4 capacity counts. */
export const GET: RequestHandler = async ({ locals }) => {
	if (!locals.session?.userId) return error(401, "Authentication required");
	const { previews, counts } = await getApplicationAdapters().vclusterPreviews.list();
	return json({ previews, counts });
};

/**
 * Launch a Tier-2 preview vcluster. Body: { name }. Claim-first (instant warm-pool
 * member), else a capacity-gated cold provision — the admission policy lives in
 * `ApplicationVclusterPreviewService`; a full cluster comes back as a typed
 * refusal that this route maps to 429.
 */
export const POST: RequestHandler = async ({ request, locals }) => {
	if (!locals.session?.userId) return error(401, "Authentication required");
	const body = (await request.json().catch(() => ({}))) as { name?: string };
	const name = safePreviewName(body.name ?? "");
	if (!name || name === "preview") return error(400, "A preview name is required");

	const result = await getApplicationAdapters().vclusterPreviews.launch({
		name,
		user: locals.session.userId,
	});
	if (!result.ok) return error(429, result.message);
	return json({ preview: result.preview, pooled: result.pooled }, { status: 202 });
};
