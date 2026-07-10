import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getApplicationAdapters } from '$lib/server/application';
import { getApplicationAdapterConfig } from '$lib/server/application/config';
import type { PreviewArchiveResult } from '$lib/server/application/preview-archive';
import { PreviewAccessDeniedError } from '$lib/server/application/preview-access';

const FULL_SHA = /^[0-9a-f]{40}$/;

/** Status of one Tier-2 preview (Job phase == environment readiness). */
export const GET: RequestHandler = async ({ params, locals }) => {
	if (!locals.session?.userId) return error(401, 'Authentication required');
	await authorizePreview(params.name, locals.session.userId);
	const preview = await getApplicationAdapters().vclusterPreviews.get(params.name);
	return json({ preview });
};

/**
 * Tear down a Tier-2 preview (drops per-preview DB + vcluster delete).
 *
 * E3: when PREVIEW_ARCHIVE_ON_TEARDOWN is on, run summaries + un-promoted
 * source bundles are archived to the host Files API FIRST (the preview's DB
 * dies with the vcluster). Mutable app-live previews require a durable archive;
 * optional archive failures on reconciled previews remain best-effort.
 */
export const DELETE: RequestHandler = async ({ params, locals }) => {
	if (!locals.session?.userId) return error(401, 'Authentication required');
	const access = await authorizePreview(params.name, locals.session.userId);

	let archive: PreviewArchiveResult | null = null;
	const archiveRequired = access.preview.profile === 'app-live' && access.preview.mode === 'live';
	if (archiveRequired || getApplicationAdapterConfig().previewArchiveOnTeardownEnabled) {
		try {
			archive = await getApplicationAdapters().previewArchive.archivePreview({
				name: params.name,
				userId: access.ownerId,
				projectId: access.actorIsOwner ? (locals.session.projectId ?? null) : null
			});
		} catch (err) {
			if (archiveRequired) {
				return error(
					409,
					`Preview archive failed; teardown refused: ${err instanceof Error ? err.message : String(err)}`
				);
			}
			console.warn(
				`[vcluster-preview] optional archive-on-teardown failed for ${params.name}:`,
				err instanceof Error ? err.message : err
			);
			archive = {
				archived: false,
				preview: params.name,
				reason: err instanceof Error ? err.message : String(err)
			};
		}
		if (archiveRequired && !archive.archived) {
			return error(409, `Preview archive is incomplete; teardown refused: ${archive.reason}`);
		}
	}

	const requestId =
		typeof access.preview.provenance?.requestId === 'string'
			? access.preview.provenance.requestId
			: null;
	if (
		!requestId ||
		!access.preview.sourceRevision ||
		!FULL_SHA.test(access.preview.sourceRevision)
	) {
		return error(409, 'Preview teardown ownership tuple is incomplete');
	}
	const preview = await getApplicationAdapters().vclusterPreviews.teardown(params.name, {
		mode: 'owned',
		requestId,
		sourceRevision: access.preview.sourceRevision,
		...(archive?.archived === true ? { archiveConfirmed: true } : {})
	});
	return json({ preview, ...(archive ? { archive } : {}) });
};

async function authorizePreview(name: string, actorUserId: string) {
	try {
		return await getApplicationAdapters().previewAccess.authorize({
			name,
			actorUserId
		});
	} catch (cause) {
		if (cause instanceof PreviewAccessDeniedError) return error(403, cause.message);
		throw cause;
	}
}
