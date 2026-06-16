import { error, json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { listRuntimes } from "$lib/server/agents/runtime-registry";

/**
 * GET /api/runtimes — read-only projection of the runtime registry SSOT for the
 * canvas agent node's capability-driven config UI. An agent's `runtime` field
 * resolves to one of these descriptors; the config panel uses the capabilities
 * to decide which options are relevant (model override, CLI credential prereq,
 * native-vs-custom goal, etc.) so new runtimes surface automatically.
 */
export const GET: RequestHandler = async ({ locals }) => {
	if (!locals.session?.userId) return error(401, "Authentication required");
	const runtimes = listRuntimes().map((d) => ({
		id: d.id,
		family: d.family,
		cliAdapter: d.cliAdapter ?? null,
		capabilities: d.capabilities,
		cliAuth: d.cliAuth
			? {
					provider: d.cliAuth.provider,
					credentialKind: d.cliAuth.credentialKind,
					loginStyle: d.cliAuth.loginStyle ?? null,
				}
			: null,
	}));
	return json({ runtimes });
};
