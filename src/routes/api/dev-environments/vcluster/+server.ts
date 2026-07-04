import { env } from "$env/dynamic/private";
import { error, json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import {
	claimVclusterPreview,
	listVclusterPreviewsWithCounts,
	provisionVclusterPreview,
	safePreviewName,
} from "$lib/server/workflows/vcluster-preview";

/** Max concurrent AWAKE Tier-2 vclusters (each is heavy ~4–6 cores). */
function maxPreviews(): number {
	const n = Number(env.VCLUSTER_PREVIEW_MAX ?? "6");
	return Number.isFinite(n) && n > 0 ? n : 6;
}

/** List Tier-2 (vcluster full-isolation) previews. */
export const GET: RequestHandler = async ({ locals }) => {
	if (!locals.session?.userId) return error(401, "Authentication required");
	const { previews, counts } = await listVclusterPreviewsWithCounts();
	return json({ previews, counts });
};

/** Launch a Tier-2 preview vcluster. Body: { name }. A3: claim a warm-pool member first
 * (instant, no new capacity), and only capacity-gate the cold-provision fallback. */
export const POST: RequestHandler = async ({ request, locals }) => {
	if (!locals.session?.userId) return error(401, "Authentication required");
	const body = (await request.json().catch(() => ({}))) as { name?: string };
	const name = safePreviewName(body.name ?? "");
	if (!name || name === "preview")
		return error(400, "A preview name is required");

	// Claim-first: a free warm-pool member comes up instantly and consumes an already-awake
	// slot, so it needs no capacity check. Returns null when the pool is empty/off (or a cold
	// preview already owns this name) → fall through to the cold path.
	const claimed = await claimVclusterPreview({ name, user: locals.session.userId });
	if (claimed) return json({ preview: claimed, pooled: true }, { status: 202 });

	// Cold fallback: a full vcluster preview is heavy + isn't host-Kueue-gated, so this is the
	// admission control. Gate on AWAKE previews (which includes free pool members). Re-provisioning
	// an existing preview of this name is always allowed.
	const { previews, counts } = await listVclusterPreviewsWithCounts();
	const cap = maxPreviews();
	const alreadyThis = previews.some((p) => p.name === name);
	const awake = counts?.awake ?? previews.length;
	if (!alreadyThis && awake >= cap)
		return error(
			429,
			`Preview capacity reached (${awake}/${cap}). Tear one down first.`,
		);
	const preview = await provisionVclusterPreview({ name });
	return json({ preview }, { status: 202 });
};
