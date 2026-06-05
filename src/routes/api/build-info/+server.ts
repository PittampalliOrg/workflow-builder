import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';

/**
 * GET /api/build-info
 *
 * Lightweight, unauthenticated build marker used to verify that a new
 * workflow-builder image has actually rolled out end-to-end through the
 * GitOps outer-loop (build -> commit-pin -> render-ryzen-image -> ArgoCD).
 *
 * The `marker` is bumped intentionally to make a specific deploy observable.
 */
export const GET: RequestHandler = async () => {
	return json({
		service: 'workflow-builder',
		marker: 'gitops-demo-2026-06-04-1',
		message: 'GitOps outer-loop end-to-end demo build',
		builtAt: new Date().toISOString(),
	});
};
