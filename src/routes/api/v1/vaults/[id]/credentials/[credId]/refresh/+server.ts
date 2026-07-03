import { error, json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { getApplicationAdapters } from "$lib/server/application";
import { ApplicationVaultCredentialError } from "$lib/server/application/vault-credentials";

/**
 * Trigger an OAuth refresh_token grant for a single credential on demand.
 * Used by the vault detail "Rotate now" button. Idempotent — if the refresh
 * fails, the old credential stays in place and a failure log row lands in
 * `vault_credential_refresh_log`.
 */
export const POST: RequestHandler = async ({ params, locals }) => {
	if (!locals.session?.userId) return error(401, "Authentication required");
	try {
		const result = await getApplicationAdapters().vaultCredentials.refreshOne({
			vaultId: params.id,
			credentialId: params.credId,
		});
		if (!result.ok) {
			return json(
				{
					ok: false,
					error: result.error,
					httpStatus: result.httpStatus,
					skipped: result.skipped ?? false,
				},
				{ status: result.skipped ? 400 : 502 },
			);
		}
		return json({
			ok: true,
			expiresAt: result.expiresAt,
			httpStatus: result.httpStatus,
		});
	} catch (err) {
		handleVaultCredentialError(err);
	}
};

function handleVaultCredentialError(err: unknown): never {
	if (err instanceof ApplicationVaultCredentialError) {
		throw error(err.status, err.message);
	}
	throw err;
}
