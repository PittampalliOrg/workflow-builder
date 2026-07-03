import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getApplicationAdapters } from '$lib/server/application';
import type { AdminPieceRuntimeImageStatus } from '$lib/server/application/ports';
import { requireInternal } from '$lib/server/internal-auth';

/**
 * Build-completion callback for per-piece runtime images
 * (docs/per-piece-runtime-images.md). The hub Tekton `perpiece-image-build` pipeline
 * POSTs here after build+smoke (status=ready, with image+digest) or on failure
 * (status=failed, with errorMessage). Internal-token auth (INTERNAL_API_TOKEN).
 *
 * On `ready` we flip the piece to runnable (`available_only=false` + clear blocklist)
 * ONLY when an admin enabled it (the `piece_images` row carries enable intent via
 * enabledAt) — so a bare CI prebuild never auto-enables a piece nobody asked for.
 */
export const POST: RequestHandler = async ({ request, params }) => {
	requireInternal(request);
	const pieceName = decodeURIComponent(params.pieceName);

	let body: {
		version?: string;
		image?: string;
		digest?: string;
		status?: AdminPieceRuntimeImageStatus;
		errorMessage?: string;
	};
	try {
		body = await request.json();
	} catch {
		return error(400, 'invalid JSON body');
	}

	const { version, image, digest, status, errorMessage } = body;
	if (!version) return error(400, 'version is required');
	if (!status || !['building', 'ready', 'failed'].includes(status)) {
		return error(400, 'status must be one of building|ready|failed');
	}
	if (status === 'ready' && !image) return error(400, 'image is required when status=ready');

	try {
		const result = await getApplicationAdapters().workflowData.recordAdminPieceRuntimeImageResult({
			pieceName,
			version,
			status,
			image,
			digest,
			errorMessage,
		});
		return json({ ok: true, ...result });
	} catch (err) {
		const msg = err instanceof Error ? err.message : 'image registration failed';
		if (/invalid piece name|version is required|status must be|image is required/.test(msg)) {
			return error(400, msg);
		}
		return error(500, msg);
	}
};
