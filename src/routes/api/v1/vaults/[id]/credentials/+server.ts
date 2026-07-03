import { error, json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import {
	ApplicationVaultCredentialError,
} from "$lib/server/application/vault-credentials";
import { getApplicationAdapters } from "$lib/server/application";

export const GET: RequestHandler = async ({ params, locals }) => {
	if (!locals.session?.userId) return error(401, "Authentication required");
	try {
		return json(
			await getApplicationAdapters().vaultCredentials.list({
				vaultId: params.id,
			}),
		);
	} catch (err) {
		handleVaultCredentialError(err);
	}
};

export const POST: RequestHandler = async ({ params, request, locals }) => {
	if (!locals.session?.userId) return error(401, "Authentication required");
	try {
		return json(
			await getApplicationAdapters().vaultCredentials.create({
				vaultId: params.id,
				body: await request.json().catch(() => ({})),
			}),
			{ status: 201 },
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
