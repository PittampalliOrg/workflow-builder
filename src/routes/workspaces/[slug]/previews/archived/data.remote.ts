import { error } from "@sveltejs/kit";
import { getRequestEvent, query } from "$app/server";
import { getApplicationAdapters } from "$lib/server/application";
import type {
	ArchivedPreviewDetail,
	ArchivedPreviewListItem,
} from "$lib/server/application/preview-archive";

export type {
	ArchivedPreviewDetail,
	ArchivedPreviewListItem,
} from "$lib/server/application/preview-archive";

/** Archived preview scopes for the current user (metadata only). */
export const getArchivedPreviews = query(
	async (): Promise<ArchivedPreviewListItem[]> => {
		const event = getRequestEvent();
		const userId = event.locals.session?.userId;
		if (!userId) error(401, "Authentication required");
		return getApplicationAdapters().previewArchive.listArchivedPreviews({
			userId,
		});
	},
);

/** One archived preview's parsed detail (executions + bundle links). Returns a
 * typed error state for missing / malformed summaries (never throws). */
export const getArchivedPreviewDetail = query(
	"unchecked",
	async (name: string): Promise<ArchivedPreviewDetail> => {
		const event = getRequestEvent();
		const userId = event.locals.session?.userId;
		if (!userId) error(401, "Authentication required");
		return getApplicationAdapters().previewArchive.getArchivedPreview({
			name,
			userId,
		});
	},
);
