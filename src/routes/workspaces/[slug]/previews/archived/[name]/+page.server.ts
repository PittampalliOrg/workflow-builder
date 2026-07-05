import { error } from "@sveltejs/kit";
import type { PageServerLoad } from "./$types";
import { getApplicationAdapters } from "$lib/server/application";

/**
 * One archived preview. The service returns a typed union — a missing / malformed
 * summary is data (`{ ok:false, reason }`), not a thrown 404, so the page can
 * still surface the raw file list for recovery.
 */
export const load: PageServerLoad = async ({ params, locals }) => {
	if (!locals.session?.userId) error(401, "Authentication required");
	const detail = await getApplicationAdapters().previewArchive.getArchivedPreview(
		{ name: params.name, userId: locals.session.userId },
	);
	return { detail };
};
