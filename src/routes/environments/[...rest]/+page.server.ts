import { redirect } from "@sveltejs/kit";
import { DEFAULT_WORKSPACE_SLUG } from "$lib/utils/workspace-path";

export const load = ({ params, url }) => {
	const rest = params.rest ?? "";
	const qs = url.search ?? "";
	throw redirect(307, `/workspaces/${DEFAULT_WORKSPACE_SLUG}/environments/${rest}${qs}`);
};
