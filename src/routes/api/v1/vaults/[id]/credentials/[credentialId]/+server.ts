import { error, json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import {
	archiveCredential,
	getCredential,
	rotateCredential,
} from "$lib/server/vaults/credentials";
import type { VaultCredentialInput } from "$lib/types/vaults";

export const GET: RequestHandler = async ({ params, locals }) => {
	if (!locals.session?.userId) return error(401, "Authentication required");
	const credential = await getCredential(params.id, params.credentialId);
	if (!credential) return error(404, "Credential not found");
	return json({ credential });
};

export const PUT: RequestHandler = async ({ params, request, locals }) => {
	if (!locals.session?.userId) return error(401, "Authentication required");
	const body = (await request.json().catch(() => ({}))) as Record<
		string,
		unknown
	>;
	const input: Partial<VaultCredentialInput> = {};
	if (typeof body.displayName === "string") input.displayName = body.displayName;
	if (typeof body.mcpServerUrl === "string" || body.mcpServerUrl === null)
		input.mcpServerUrl = (body.mcpServerUrl as string) ?? undefined;
	if (typeof body.accessToken === "string") input.accessToken = body.accessToken;
	if (typeof body.refreshToken === "string")
		input.refreshToken = body.refreshToken;
	if (typeof body.expiresAt === "string") input.expiresAt = body.expiresAt;
	if (body.refreshMetadata && typeof body.refreshMetadata === "object") {
		input.refreshMetadata =
			body.refreshMetadata as VaultCredentialInput["refreshMetadata"];
	}
	if (typeof body.username === "string") input.username = body.username;
	if (typeof body.password === "string") input.password = body.password;
	if (typeof body.secret === "string") input.secret = body.secret;

	const credential = await rotateCredential(
		params.id,
		params.credentialId,
		input,
	);
	if (!credential) return error(404, "Credential not found");
	return json({ credential });
};

export const DELETE: RequestHandler = async ({ params, locals }) => {
	if (!locals.session?.userId) return error(401, "Authentication required");
	const ok = await archiveCredential(params.id, params.credentialId);
	if (!ok) return error(404, "Credential not found");
	return json({ archived: true });
};
