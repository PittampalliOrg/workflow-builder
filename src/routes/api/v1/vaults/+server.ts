import { error, json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { getApplicationAdapters } from "$lib/server/application";
import { ApplicationVaultError } from "$lib/server/application/vault-management";

export const GET: RequestHandler = async ({ url, locals }) => {
	if (!locals.session?.userId) return error(401, "Authentication required");
	try {
		return json(
			await getApplicationAdapters().vaults.list({
				query: url.searchParams,
				sessionProjectId: locals.session.projectId,
			}),
		);
	} catch (err) {
		handleVaultError(err);
	}
};

export const POST: RequestHandler = async ({ request, locals }) => {
	if (!locals.session?.userId) return error(401, "Authentication required");
	try {
		return json(
			await getApplicationAdapters().vaults.create({
				userId: locals.session.userId,
				body: await request.json().catch(() => ({})),
			}),
			{ status: 201 },
		);
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
