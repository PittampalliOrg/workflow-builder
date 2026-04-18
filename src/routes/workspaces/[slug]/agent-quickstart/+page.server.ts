import { redirect } from "@sveltejs/kit";

// CMA URL (/workspaces/{slug}/agent-quickstart) mirrored to our existing
// /workspaces/{slug}/agents/quickstart page so deep-links from the docs
// resolve without a 404.
export const load = ({ params, url }) => {
	throw redirect(
		308,
		`/workspaces/${params.slug}/agents/quickstart${url.search}`,
	);
};
