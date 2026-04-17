import { redirect } from "@sveltejs/kit";

export const load = ({ params, url }) => {
	const rest = params.rest ?? "";
	throw redirect(308, `/vaults/${rest}${url.search}`);
};
