import { error, json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { validateInternalToken } from "$lib/server/internal-auth";
import { refreshExpiringCredentials } from "$lib/server/vaults/refresher";

/**
 * Internal endpoint invoked by the OAuth auto-refresh scheduler (Dapr
 * scheduler cron or an external cron-worker). Drains all vault_credentials
 * whose `expiresAt` falls within the lead-time window and runs the refresh
 * grant against each one's `tokenEndpoint`.
 *
 * Idempotent — safe to call repeatedly. A too-frequent schedule is harmless
 * (credentials whose `expiresAt` is far in the future are skipped).
 */
export const POST: RequestHandler = async ({ request, url }) => {
	if (!validateInternalToken(request)) return error(401, "Unauthorized");
	const leadTimeParam = url.searchParams.get("leadTimeSeconds");
	const leadTime = leadTimeParam ? Number.parseInt(leadTimeParam, 10) : undefined;
	const report = await refreshExpiringCredentials({
		leadTimeSeconds: Number.isFinite(leadTime) ? leadTime : undefined,
	});
	return json({ report });
};
