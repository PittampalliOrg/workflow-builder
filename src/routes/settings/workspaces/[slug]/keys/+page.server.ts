import { redirect } from "@sveltejs/kit";

// CMA-shape URL. The page content lives at /settings/api-keys; scope is
// already read from the JWT's projectId so we just forward there. When
// multi-project support lands, this becomes a real page with ?slug filter.
export const load = ({ url }) => {
	throw redirect(308, `/settings/api-keys${url.search}`);
};
