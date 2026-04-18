import { redirect } from "@sveltejs/kit";
import { DEFAULT_WORKSPACE_SLUG } from "$lib/utils/workspace-path";

export const load = ({ url }) => {
	throw redirect(308, `/workspaces/${DEFAULT_WORKSPACE_SLUG}/environments${url.search}`);
};
