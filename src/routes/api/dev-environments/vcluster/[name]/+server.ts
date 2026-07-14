import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getApplicationAdapters } from '$lib/server/application';
import {
	PreviewEnvironmentDesiredStateError,
	PreviewEnvironmentDesiredStateOwnershipError,
	PreviewRuntimeIdentityChangedError
} from '$lib/server/application/ports';
import { PreviewAccessDeniedError } from '$lib/server/application/preview-access';
import { PreviewTeardownRefusedError } from '$lib/server/application/preview-teardown';
import { requirePlatformAdmin } from '$lib/server/platform-admin';

const FULL_SHA = /^[0-9a-f]{40}$/;

/** Status of one Tier-2 preview (Job phase == environment readiness). */
export const GET: RequestHandler = async ({ params, locals }) => {
	if (!locals.session?.userId) return error(401, 'Authentication required');
	const adapters = getApplicationAdapters();
	if (!adapters.previewDeploymentScope.allowsPreviewName(params.name)) {
		return error(403, 'Cross-preview access is unavailable from a preview deployment');
	}
	const access = await authorizePreview(params.name, locals.session.userId);
	const preview = adapters.vclusterPreviews.present(access.preview);
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
export const DELETE: RequestHandler = async ({ params, locals, url }) => {
	if (!locals.session?.userId) return error(401, 'Authentication required');
	try {
		const adapters = getApplicationAdapters();
		if (!adapters.previewDeploymentScope.isControlPlane()) {
			return error(403, 'Preview fleet operations are unavailable from a preview deployment');
		}
		await requirePlatformAdmin(locals);
		const expectedRequestId = url.searchParams.get('expectedRequestId') ?? '';
		const expectedSourceRevision = url.searchParams.get('expectedSourceRevision') ?? '';
		if (
			!expectedRequestId ||
			expectedRequestId.length > 256 ||
			!FULL_SHA.test(expectedSourceRevision)
		) {
			return error(400, 'The selected preview generation is required');
		}
		const discardUnarchived = url.searchParams.get('discardUnarchived') === 'true';
		const result = await adapters.previewTeardown.teardown({
			name: params.name,
			actorUserId: locals.session.userId,
			expectedRequestId,
			expectedSourceRevision,
			projectId: locals.session.projectId ?? null,
			...(discardUnarchived
				? { discardUnarchived: true }
				: url.searchParams.get('forceFailed') === 'true'
					? { forceFailed: true }
					: {})
		});
		// User teardown is an acceptance command. The signed ticket remains valid
		// after the fleet feed stops listing the terminating namespace.
		return json(
			{
				preview: adapters.vclusterPreviews.present(result.preview),
				teardown: result.ticket,
				...(result.archive ? { archive: result.archive } : {})
			},
			result.preview.phase === 'absent'
				? { status: 200 }
				: { status: 202, headers: { 'retry-after': '5' } }
		);
	} catch (cause) {
		if (cause instanceof PreviewAccessDeniedError) return error(403, cause.message);
		if (cause instanceof PreviewTeardownRefusedError) return error(409, cause.message);
		if (cause instanceof PreviewEnvironmentDesiredStateOwnershipError) {
			return error(409, cause.message);
		}
		if (cause instanceof PreviewEnvironmentDesiredStateError) return error(503, cause.message);
		throw cause;
	}
};

async function authorizePreview(name: string, actorUserId: string) {
	try {
		return await getApplicationAdapters().previewAccess.authorize({
			name,
			actorUserId
		});
	} catch (cause) {
		if (cause instanceof PreviewAccessDeniedError) return error(403, cause.message);
		if (cause instanceof PreviewRuntimeIdentityChangedError) return error(409, cause.message);
		throw cause;
	}
}
