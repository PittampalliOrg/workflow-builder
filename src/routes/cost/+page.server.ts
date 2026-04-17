import { redirect } from "@sveltejs/kit";
import { DEFAULT_WORKSPACE_SLUG } from "$lib/utils/workspace-path";

export const load = ({ url }) => {
	const qs = url.search ?? "";
	throw redirect(307, `/workspaces/${DEFAULT_WORKSPACE_SLUG}/cost${qs}`);
};
