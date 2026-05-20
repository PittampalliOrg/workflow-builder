import { error } from "@sveltejs/kit";
import { env as publicEnv } from "$env/dynamic/public";
import type { PageServerLoad } from "./$types";

import {
	DEFAULT_HEADLAMP_EMBED_BASE,
	DEFAULT_HEADLAMP_URL,
	headlampEmbedSrc,
	headlampExternalUrl,
	normalizeEmbeddedHeadlampPath,
} from "$lib/headlamp/links";

export const load: PageServerLoad = async ({ parent, url }) => {
	const layout = await parent();
	if (layout.platformRole !== "ADMIN") {
		throw error(403, "Admin access required");
	}

	const path = normalizeEmbeddedHeadlampPath(url.searchParams.get("path"));
	const embedBase = publicEnv.PUBLIC_HEADLAMP_EMBED_BASE?.trim() || DEFAULT_HEADLAMP_EMBED_BASE;
	const externalBase =
		publicEnv.PUBLIC_HEADLAMP_EXTERNAL_URL?.trim() ||
		publicEnv.PUBLIC_HEADLAMP_URL?.trim() ||
		DEFAULT_HEADLAMP_URL;

	return {
		path,
		iframeSrc: headlampEmbedSrc({ embedBase, path }),
		externalHref: headlampExternalUrl({ headlampBase: externalBase, path }),
	};
};
