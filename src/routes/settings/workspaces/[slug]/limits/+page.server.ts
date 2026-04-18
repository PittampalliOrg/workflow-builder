import { redirect } from "@sveltejs/kit";

export const load = ({ url }) => {
	throw redirect(308, `/settings/limits${url.search}`);
};
