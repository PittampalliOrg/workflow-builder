import { redirect } from "@sveltejs/kit";
import { DEFAULT_WORKSPACE_SLUG } from "$lib/utils/workspace-path";

export const load = ({ params, url }) => {
	const rest = params.rest ?? "";
	throw redirect(308, `/workspaces/${DEFAULT_WORKSPACE_SLUG}/files/${rest}${url.search}`);
};
