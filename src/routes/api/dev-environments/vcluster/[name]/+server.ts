import { error, json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { getApplicationAdapters } from "$lib/server/application";
import { getApplicationAdapterConfig } from "$lib/server/application/config";
import type { PreviewArchiveResult } from "$lib/server/application/preview-archive";

/** Status of one Tier-2 preview (Job phase == environment readiness). */
export const GET: RequestHandler = async ({ params, locals }) => {
	if (!locals.session?.userId) return error(401, "Authentication required");
	const preview = await getApplicationAdapters().vclusterPreviews.get(params.name);
	return json({ preview });
};

/**
 * Tear down a Tier-2 preview (drops per-preview DB + vcluster delete).
 *
 * E3: when PREVIEW_ARCHIVE_ON_TEARDOWN is on, run summaries + un-promoted
 * source bundles are archived to the host Files API FIRST (the preview's DB
 * dies with the vcluster). Archiving is strictly best-effort: any failure is
 * reported as `archive.archived === false` and the teardown proceeds.
 */
export const DELETE: RequestHandler = async ({ params, locals }) => {
	if (!locals.session?.userId) return error(401, "Authentication required");

	let archive: PreviewArchiveResult | null = null;
	if (getApplicationAdapterConfig().previewArchiveOnTeardownEnabled) {
		try {
			archive = await getApplicationAdapters().previewArchive.archivePreview({
				name: params.name,
				userId: locals.session.userId,
				projectId: locals.session.projectId ?? null,
			});
		} catch (err) {
			console.warn(
				`[vcluster-preview] archive-on-teardown failed for ${params.name} (teardown proceeds):`,
				err instanceof Error ? err.message : err,
			);
			archive = {
				archived: false,
				preview: params.name,
				reason: err instanceof Error ? err.message : String(err),
			};
		}
	}

	const preview = await getApplicationAdapters().vclusterPreviews.teardown(params.name);
	return json({ preview, ...(archive ? { archive } : {}) });
};
