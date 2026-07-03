import { error, json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { validateInternalToken } from "$lib/server/internal-auth";
import { getApplicationAdapters } from "$lib/server/application";
import {
	ApplicationVaultCredentialError,
} from "$lib/server/application/vault-credentials";

/**
 * Internal endpoint used by function-router to resolve an MCP credential at
 * tool-call time. Body:
 *   { vaultIds: string[], mcpServerUrl: string }
 *
 * Returns the decrypted credential payload — access token + auth type —
 * plus metadata. Updates the credential's `lastUsedAt`. Intended to be
 * called with the internal API token; never exposed to the browser.
 *
 * This is the proxy boundary for the CMA-style vault model: sandboxed
 * processes request credentials from function-router, which requests them
 * here, which decrypts and returns — the sandbox never sees the secret.
 */
export const POST: RequestHandler = async ({ request }) => {
	if (!validateInternalToken(request)) return error(401, "Unauthorized");
	try {
		return json(
			await getApplicationAdapters().vaultCredentials.resolveForMcpServer({
				body: await request.json().catch(() => ({})),
			}),
		);
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
