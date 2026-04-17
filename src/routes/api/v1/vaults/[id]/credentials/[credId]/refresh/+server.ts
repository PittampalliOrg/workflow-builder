import { error, json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { refreshSingleCredential } from "$lib/server/vaults/refresher";

/**
 * Trigger an OAuth refresh_token grant for a single credential on demand.
 * Used by the vault detail "Rotate now" button. Idempotent — if the refresh
 * fails, the old credential stays in place and a failure log row lands in
 * `vault_credential_refresh_log`.
 */
export const POST: RequestHandler = async ({ params, locals }) => {
	if (!locals.session?.userId) return error(401, "Authentication required");
	const result = await refreshSingleCredential(params.id, params.credId);
	if (!result.ok) {
		return json(
			{
				ok: false,
				error: result.error,
				httpStatus: result.httpStatus,
				skipped: (result as { skipped?: boolean }).skipped ?? false,
			},
			{ status: (result as { skipped?: boolean }).skipped ? 400 : 502 },
		);
	}
	return json({
		ok: true,
		expiresAt: result.expiresAt,
		httpStatus: result.httpStatus,
	});
};
