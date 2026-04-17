import { error, json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import {
	createCredential,
	listCredentials,
} from "$lib/server/vaults/credentials";
import type { VaultCredentialInput } from "$lib/types/vaults";
import { getVault } from "$lib/server/vaults/registry";

export const GET: RequestHandler = async ({ params, locals }) => {
	if (!locals.session?.userId) return error(401, "Authentication required");
	const credentials = await listCredentials(params.id);
	return json({ credentials });
};

export const POST: RequestHandler = async ({ params, request, locals }) => {
	if (!locals.session?.userId) return error(401, "Authentication required");
	const vault = await getVault(params.id);
	if (!vault) return error(404, "Vault not found");

	const body = (await request.json().catch(() => ({}))) as Record<
		string,
		unknown
	>;
	const input = validateInput(body);
	if (typeof input === "string") return error(400, input);
	try {
		const credential = await createCredential(params.id, input);
		return json({ credential }, { status: 201 });
	} catch (err) {
		return error(
			400,
			err instanceof Error ? err.message : "Credential create failed",
		);
	}
};

function validateInput(body: Record<string, unknown>): VaultCredentialInput | string {
	const authType = body.authType;
	if (
		authType !== "mcp_oauth" &&
		authType !== "bearer" &&
		authType !== "basic" &&
		authType !== "secret_text"
	) {
		return "authType must be one of mcp_oauth, bearer, basic, secret_text";
	}
	const displayName =
		typeof body.displayName === "string" && body.displayName.trim()
			? body.displayName.trim()
			: "";
	if (!displayName) return "displayName is required";
	return {
		displayName,
		authType,
		mcpServerUrl:
			typeof body.mcpServerUrl === "string" ? body.mcpServerUrl : undefined,
		accessToken:
			typeof body.accessToken === "string" ? body.accessToken : undefined,
		refreshToken:
			typeof body.refreshToken === "string" ? body.refreshToken : undefined,
		expiresAt:
			typeof body.expiresAt === "string" ? body.expiresAt : undefined,
		refreshMetadata:
			body.refreshMetadata && typeof body.refreshMetadata === "object"
				? (body.refreshMetadata as VaultCredentialInput["refreshMetadata"])
				: undefined,
		username: typeof body.username === "string" ? body.username : undefined,
		password: typeof body.password === "string" ? body.password : undefined,
		secret: typeof body.secret === "string" ? body.secret : undefined,
	};
}
