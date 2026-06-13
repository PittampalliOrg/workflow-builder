import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { requireInternal } from '$lib/server/internal-auth';
import { reconcileBuildingImages } from '$lib/server/pieces/piece-images';

/**
 * Spoke-side polling reconcile for per-piece runtime images
 * (docs/per-piece-runtime-images.md). The per-piece build runs on the hub, but the
 * cross-cluster register callback can't resolve a spoke's Tailscale MagicDNS — so each
 * spoke periodically POSTs here to reconcile its OWN `building` rows against GHCR
 * (in-cluster, no MagicDNS, no egress). No body; returns the reconcile counts.
 * Internal-token auth (INTERNAL_API_TOKEN).
 */
export const POST: RequestHandler = async ({ request }) => {
	requireInternal(request);
	const result = await reconcileBuildingImages();
	return json(result);
};
