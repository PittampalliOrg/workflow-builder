import type { ExecutionWorkspaceRouteInfo } from '$lib/server/application/ports';

export type ExecutionWorkspaceRoute = ExecutionWorkspaceRouteInfo;

export function buildRuntimePreviewPath(
	executionId: string,
	workspaceSlug: string,
	search = ''
): string {
	const normalizedSearch = search ? (search.startsWith('?') ? search : `?${search}`) : '';
	return `/workspaces/${encodeURIComponent(workspaceSlug)}/workflows/runtime-preview/${encodeURIComponent(executionId)}${normalizedSearch}`;
}
