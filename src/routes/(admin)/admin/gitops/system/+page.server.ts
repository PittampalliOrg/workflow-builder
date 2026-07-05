import { redirect } from "@sveltejs/kit";

import type { PageServerLoad } from "./$types";

// The pipeline "system" view is now the default Overview tab of the consolidated
// /admin/gitops surface. Permanent-redirect legacy links, preserving the query
// string (notably `?select=` deep-links and `?strategy=`).
export const load: PageServerLoad = async ({ url }) => {
	redirect(308, `/admin/gitops${url.search}`);
};
