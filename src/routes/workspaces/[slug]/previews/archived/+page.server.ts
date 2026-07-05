import { error } from "@sveltejs/kit";
import type { PageServerLoad } from "./$types";
import { getApplicationAdapters } from "$lib/server/application";

/**
 * The archived-previews browser (E3): every teardown-archived Tier-2 preview
 * scope (`preview-archive:<name>`) with run/bundle counts. SSR'd for auth +
 * first paint; the client Refresh re-reads through the remote query.
 */
export const load: PageServerLoad = async ({ locals }) => {
	if (!locals.session?.userId) error(401, "Authentication required");
	const previews = await getApplicationAdapters().previewArchive.listArchivedPreviews(
		{ userId: locals.session.userId },
	);
	return { previews };
};
