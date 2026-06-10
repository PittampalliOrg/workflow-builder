import type { PageServerLoad } from "./$types";
import { listRuntimes } from "$lib/server/agents/runtime-registry";
import { getUserCliCredentialSummary } from "$lib/server/users/cli-credentials";

/**
 * Settings → CLI tokens. One card per runtime-registry descriptor that
 * declares `cliAuth` (currently `claude-code-cli`). Loads presence/expiry
 * metadata only — the token itself never leaves the server.
 */
export const load: PageServerLoad = async ({ locals }) => {
	const runtimes = listRuntimes()
		.filter((d) => d.cliAuth)
		.map((d) => ({
			id: d.id,
			displayName: d.agentMetadataFramework,
			cliAuth: d.cliAuth!,
		}));

	const userId = locals.session?.userId ?? null;
	const providers = [...new Set(runtimes.map((r) => r.cliAuth.provider))];
	const tokenEntries = userId
		? await Promise.all(
				providers.map(async (provider) => {
					try {
						return await getUserCliCredentialSummary(userId, provider);
					} catch {
						return {
							provider,
							linked: false,
							expiresAt: null,
							lastValidatedAt: null,
							status: null,
						};
					}
				}),
			)
		: [];

	return {
		cliRuntimes: runtimes,
		tokensByProvider: Object.fromEntries(
			tokenEntries.map((t) => [t.provider, t]),
		),
	};
};
