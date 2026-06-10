import type { PageServerLoad } from "./$types";
import { listRuntimes } from "$lib/server/agents/runtime-registry";

/**
 * Exposes the runtime-registry's per-runtime `cliAuth` contract to the
 * new-session form so it can render a token-readiness chip (and block
 * submit) when the selected agent's runtime needs a per-user CLI
 * subscription token. Only metadata — never tokens.
 */
export const load: PageServerLoad = async () => {
	return {
		cliAuthByRuntime: Object.fromEntries(
			listRuntimes()
				.filter((d) => d.cliAuth)
				.map((d) => [
					d.id,
					{
						provider: d.cliAuth!.provider,
						setupCommand: d.cliAuth!.setupCommand,
					},
				]),
		) as Record<string, { provider: string; setupCommand: string }>,
	};
};
