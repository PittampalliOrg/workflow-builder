import { error, json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { getApplicationAdapters } from "$lib/server/application";

/**
 * GET /api/v1/security/audit
 *
 * Aggregated audit stream for the caller's active workspace. Stitches
 * three sources:
 *   - credential_access_logs (who/what pulled a secret)
 *   - project_members (who joined / changed role — joined time only)
 *   - runtime_config_audit_logs (dynamic config writes)
 *
 * Returns the 100 most recent events merged by timestamp DESC.
 */
export const GET: RequestHandler = async ({ locals }) => {
	if (!locals.session?.userId) return error(401, "Authentication required");

	try {
		return json(
			await getApplicationAdapters().workflowData.getSecurityAudit({
				projectId: locals.session.projectId ?? null,
			}),
		);
	} catch (err) {
		const message = err instanceof Error ? err.message : "";
		if (/Database not configured/.test(message)) {
			return error(503, "Database not configured");
		}
		throw err;
	}
};
