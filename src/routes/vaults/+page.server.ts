import { redirect } from "@sveltejs/kit";
import { DEFAULT_WORKSPACE_SLUG } from "$lib/utils/workspace-path";

export const load = () => {
	throw redirect(307, `/workspaces/${DEFAULT_WORKSPACE_SLUG}/vaults`);
};
