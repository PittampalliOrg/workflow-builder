import { error } from "@sveltejs/kit";
import { env as publicEnv } from "$env/dynamic/public";
import type { PageServerLoad } from "./$types";

import {
	DEFAULT_ARGOCD_EMBED_BASE,
	DEFAULT_ARGOCD_URL,
	argocdEmbedSrc,
	argocdExternalUrl,
	normalizeEmbeddedAppPath,
} from "$lib/embedded-apps/links";

export const load: PageServerLoad = async ({ parent, params, url }) => {
	const layout = await parent();
	if (layout.platformRole !== "ADMIN") {
		throw error(403, "Admin access required");
	}

	const embedBase = publicEnv.PUBLIC_ARGOCD_EMBED_BASE?.trim() || DEFAULT_ARGOCD_EMBED_BASE;
	const externalBase = publicEnv.PUBLIC_ARGOCD_URL?.trim() || DEFAULT_ARGOCD_URL;
	const path = normalizeEmbeddedAppPath({ value: url.searchParams.get("path"), embedBase });

	return {
		slug: params.slug,
		path,
		embedBase,
		externalBase,
		iframeSrc: argocdEmbedSrc({ embedBase, path }),
		externalHref: argocdExternalUrl({ argocdBase: externalBase, embedBase, path }),
	};
};
