export const MAX_WORKSPACE_RETENTION_TTL_SECONDS = 24 * 60 * 60;

/** Keep generated workspace TTLs inside the provider's product contract. */
export function retainedWorkspaceTtlSeconds(
	timeoutSeconds: number,
	minimumSeconds = 2 * 60 * 60,
): number {
	return Math.min(
		MAX_WORKSPACE_RETENTION_TTL_SECONDS,
		Math.max(Math.trunc(timeoutSeconds) + 60 * 60, minimumSeconds),
	);
}
