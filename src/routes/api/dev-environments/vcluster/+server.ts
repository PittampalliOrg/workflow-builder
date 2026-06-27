import { env } from "$env/dynamic/private";
import { error, json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import {
	launchVclusterPreview,
	listVclusterPreviews,
	safePreviewName,
} from "$lib/server/workflows/vcluster-preview";

/** Max concurrent Tier-2 vclusters (each is heavy ~4–6 cores). */
function maxPreviews(): number {
	const n = Number(env.VCLUSTER_PREVIEW_MAX ?? "6");
	return Number.isFinite(n) && n > 0 ? n : 6;
}

/** List Tier-2 (vcluster full-isolation) previews. */
export const GET: RequestHandler = async ({ locals }) => {
	if (!locals.session?.userId) return error(401, "Authentication required");
	const previews = await listVclusterPreviews();
	return json({ previews });
};

/** Launch a Tier-2 preview vcluster. Body: { name }. */
export const POST: RequestHandler = async ({ request, locals }) => {
	if (!locals.session?.userId) return error(401, "Authentication required");
	const body = (await request.json().catch(() => ({}))) as { name?: string };
	const name = safePreviewName(body.name ?? "");
	if (!name || name === "preview")
		return error(400, "A preview name is required");
	// Capacity guard: a full vcluster preview is heavy + isn't host-Kueue-gated,
	// so this is the admission control. Re-provisioning an existing one is allowed.
	const existing = await listVclusterPreviews();
	const cap = maxPreviews();
	const alreadyThis = existing.some((p) => p.name === name);
	if (!alreadyThis && existing.length >= cap)
		return error(
			429,
			`Preview capacity reached (${existing.length}/${cap}). Tear one down first.`,
		);
	const preview = await launchVclusterPreview({ name });
	return json({ preview }, { status: 202 });
};
