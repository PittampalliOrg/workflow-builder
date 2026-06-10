/**
 * Per-piece piece-runtime service addressing.
 *
 * Each Activepieces piece is deployed as its own Knative Service named
 * `ap-<sanitized-piece>-service` (one image per piece, serving /execute,
 * /options and /mcp). The sanitize rules here MUST match the stacks
 * activepieces-mcp reconciler's `sanitize_piece` and function-router's
 * `sanitizePieceName` (services/function-router/src/core/registry.ts) —
 * if they drift, the BFF will address a service the reconciler never created.
 */

import { env } from '$env/dynamic/private';

const DEFAULT_FUNCTIONS_NAMESPACE = 'workflow-builder';

/**
 * Sanitize an AP piece name to its service-name segment:
 * lowercase → strip "@activepieces/piece-" → non [a-z0-9-] → "-" →
 * collapse runs of "-" → trim leading/trailing "-".
 */
export function sanitizePieceName(piece: string): string {
	return piece
		.toLowerCase()
		.replace(/^@activepieces\/piece-/, '')
		.replace(/[^a-z0-9-]/g, '-')
		.replace(/-+/g, '-')
		.replace(/^-/, '')
		.replace(/-$/, '');
}

/** Knative Service name for a piece (reconciler naming contract). */
export function apPieceServiceName(piece: string): string {
	return `ap-${sanitizePieceName(piece)}-service`;
}

/**
 * Cluster-local base URL for a piece's runtime service. Knative cluster-local
 * Services expose port 80.
 */
export function apPieceServiceUrl(piece: string): string {
	const namespace = env.FUNCTIONS_NAMESPACE || DEFAULT_FUNCTIONS_NAMESPACE;
	return `http://${apPieceServiceName(piece)}.${namespace}.svc.cluster.local`;
}
