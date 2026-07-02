import type { PageServerLoad, Actions } from "./$types";
import { error, fail } from "@sveltejs/kit";
import { getApplicationAdapters } from "$lib/server/application";
import { getAppUrl } from "$lib/server/app-url";
import { enablePiece, isValidPieceSlug } from "$lib/server/pieces/piece-images";

/**
 * Re-check platform admin INSIDE the action. The (admin) layout guard only runs
 * on page loads, not on POSTed form actions, so a direct POST would otherwise
 * bypass it.
 */
async function requireAdmin(userId: string | undefined | null): Promise<void> {
	if (!userId) throw error(403, "Admin access required");
	const profile = await getApplicationAdapters().workflowData.getUserProfile(userId);
	if (profile?.platformRole !== "ADMIN") throw error(403, "Admin access required");
}

export const load: PageServerLoad = async () => {
	return getApplicationAdapters().workflowData.getAdminPiecesReadModel();
};

export const actions: Actions = {
	toggle: async ({ request, locals }) => {
		await requireAdmin(locals.session?.userId);
		const form = await request.formData();
		const pieceName = String(form.get("pieceName") ?? "").trim();
		const enable = String(form.get("enable")) === "true";
		if (!pieceName) return fail(400, { error: "pieceName required" });
		await getApplicationAdapters().workflowData.setAdminPieceEnabled({
			pieceName,
			enabled: enable,
			disabledBy: locals.session?.userId ?? null,
		});
		return { success: true, pieceName, enabled: enable };
	},

	// Enable an available-only catalog piece via its per-piece runtime image. Instant
	// when the GHCR image already exists; otherwise records `building` + triggers a
	// hub build (docs/per-piece-runtime-images.md).
	enable: async ({ request, locals, url }) => {
		await requireAdmin(locals.session?.userId);
		const form = await request.formData();
		const pieceName = String(form.get("pieceName") ?? "").trim();
		if (!pieceName || !isValidPieceSlug(pieceName)) return fail(400, { error: "valid pieceName required" });
		try {
			const callbackUrl = await getAppUrl(url, request);
			const result = await enablePiece(pieceName, { callbackUrl });
			return { success: true, ...result };
		} catch (err) {
			const msg = err instanceof Error ? err.message : "enable failed";
			return fail(/not in the catalog/.test(msg) ? 404 : 500, { error: msg, pieceName });
		}
	},
};
