import { error, json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { getVersion, restoreVersion } from "$lib/server/agents/registry";

export const GET: RequestHandler = async ({ params, locals }) => {
	if (!locals.session?.userId) return error(401, "Authentication required");
	const versionNum = Number.parseInt(params.version, 10);
	if (!Number.isFinite(versionNum) || versionNum <= 0) {
		return error(400, "Invalid version");
	}
	const result = await getVersion(params.id, versionNum);
	if (!result) return error(404, "Version not found");
	return json(result);
};

export const POST: RequestHandler = async ({ params, locals }) => {
	if (!locals.session?.userId) return error(401, "Authentication required");
	const versionNum = Number.parseInt(params.version, 10);
	if (!Number.isFinite(versionNum) || versionNum <= 0) {
		return error(400, "Invalid version");
	}
	const agent = await restoreVersion(
		params.id,
		versionNum,
		locals.session.userId,
	);
	if (!agent) return error(404, "Version not found");
	return json({ agent });
};
