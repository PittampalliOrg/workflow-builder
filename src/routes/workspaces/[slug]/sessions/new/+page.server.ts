import type { PageServerLoad } from "./$types";
import { getApplicationAdapters } from "$lib/server/application";

/**
 * Exposes the runtime-registry's per-runtime `cliAuth` contract to the
 * new-session form so it can render a token-readiness chip (and block
 * submit) when the selected agent's runtime needs a per-user CLI
 * subscription token. Only metadata — never tokens.
 */
export const load: PageServerLoad = async () => {
	return getApplicationAdapters().workflowData.getNewSessionPageReadModel();
};
