import type { PageServerLoad } from "./$types";

/**
 * The Drasi dashboard renders the configured topology from the client-safe
 * catalog (`$lib/drasi/catalog`) and fetches dynamic state from API routes in
 * the browser. The load function deliberately stays thin: no database access,
 * no Drizzle imports — route code must go through application ports/adapters.
 *
 * The admin gate itself lives in `src/routes/(admin)/+layout.server.ts`.
 */
export const load: PageServerLoad = async () => {
	return {
		generatedAt: new Date().toISOString(),
	};
};
