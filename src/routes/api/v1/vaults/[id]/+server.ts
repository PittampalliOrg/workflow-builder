import { error, json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { getApplicationAdapters } from "$lib/server/application";
import { ApplicationVaultError } from "$lib/server/application/vault-management";

export const GET: RequestHandler = async ({ params, locals }) => {
	if (!locals.session?.userId) return error(401, "Authentication required");
	try {
		return json(await getApplicationAdapters().vaults.get({ id: params.id }));
	} catch (err) {
		handleVaultError(err);
	}
};

export const PUT: RequestHandler = async ({ params, request, locals }) => {
	if (!locals.session?.userId) return error(401, "Authentication required");
	try {
		return json(
			await getApplicationAdapters().vaults.update({
				id: params.id,
				body: await request.json().catch(() => ({})),
			}),
		);
	} catch (err) {
		handleVaultError(err);
	}
};

export const DELETE: RequestHandler = async ({ params, locals }) => {
	if (!locals.session?.userId) return error(401, "Authentication required");
	try {
		return json(await getApplicationAdapters().vaults.archive({ id: params.id }));
	} catch (err) {
		handleVaultError(err);
	}
};

function handleVaultError(err: unknown): never {
	if (err instanceof ApplicationVaultError) {
		throw error(err.status, err.message);
	}
	throw err;
}
