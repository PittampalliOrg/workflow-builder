import type { PageServerLoad } from "./$types";
import { getApplicationAdapters } from "$lib/server/application";

export const load: PageServerLoad = () => ({
	socialAuth: getApplicationAdapters().deploymentCapabilities.socialAuthReadModel(),
});
