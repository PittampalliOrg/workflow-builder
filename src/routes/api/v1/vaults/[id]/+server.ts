import { error, json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import {
	archiveVault,
	getVault,
	updateVault,
} from "$lib/server/vaults/registry";

export const GET: RequestHandler = async ({ params, locals }) => {
	if (!locals.session?.userId) return error(401, "Authentication required");
	const vault = await getVault(params.id);
	if (!vault) return error(404, "Vault not found");
	return json({ vault });
};

export const PUT: RequestHandler = async ({ params, request, locals }) => {
	if (!locals.session?.userId) return error(401, "Authentication required");
	const body = (await request.json().catch(() => ({}))) as Record<
		string,
		unknown
	>;
	const vault = await updateVault(params.id, {
		name: typeof body.name === "string" ? body.name : undefined,
		description:
			typeof body.description === "string" || body.description === null
				? (body.description as string | null)
				: undefined,
	});
	if (!vault) return error(404, "Vault not found");
	return json({ vault });
};

export const DELETE: RequestHandler = async ({ params, locals }) => {
	if (!locals.session?.userId) return error(401, "Authentication required");
	const ok = await archiveVault(params.id);
	if (!ok) return error(404, "Vault not found");
	return json({ archived: true });
};
