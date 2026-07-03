import type { PageServerLoad } from "./$types";
import { getApplicationAdapters } from "$lib/server/application";

/**
 * Settings → CLI tokens. One card per runtime-registry descriptor that
 * declares `cliAuth` (currently `claude-code-cli`). Loads presence/expiry
 * metadata only — the token itself never leaves the server.
 */
export const load: PageServerLoad = async ({ locals }) => {
	return getApplicationAdapters().settingsCliTokens.load({
		userId: locals.session?.userId ?? null,
	});
};
