import { error, json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { validateInternalToken } from "$lib/server/internal-auth";
import { findCredentialForMcpServer } from "$lib/server/vaults/credentials";

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
	const body = (await request.json().catch(() => ({}))) as Record<
		string,
		unknown
	>;
	const vaultIds = Array.isArray(body.vaultIds)
		? (body.vaultIds as unknown[]).filter(
				(v): v is string => typeof v === "string",
			)
		: [];
	const mcpServerUrl =
		typeof body.mcpServerUrl === "string" ? body.mcpServerUrl : "";
	if (!mcpServerUrl) return error(400, "mcpServerUrl is required");
	if (vaultIds.length === 0) return json({ credential: null });

	const credential = await findCredentialForMcpServer(vaultIds, mcpServerUrl);
	return json({ credential });
};
