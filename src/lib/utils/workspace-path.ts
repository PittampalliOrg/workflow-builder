/**
 * CMA-style flat routes. Workspace scope is now resolved server-side from
 * the JWT `projectId` claim; URLs no longer carry the slug. This helper is
 * retained as a thin identity wrapper so older call sites compile unchanged
 * — all new code should link to `/sessions`, `/agents`, etc. directly.
 */

export const DEFAULT_WORKSPACE_SLUG = "default";

export function wsPath(_slug: string, suffix: string): string {
	return suffix.startsWith("/") ? suffix : `/${suffix}`;
}
