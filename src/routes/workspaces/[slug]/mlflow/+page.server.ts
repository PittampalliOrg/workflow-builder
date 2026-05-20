import { error } from "@sveltejs/kit";
import { env as publicEnv } from "$env/dynamic/public";
import type { PageServerLoad } from "./$types";

import {
	DEFAULT_MLFLOW_EMBED_BASE,
	DEFAULT_MLFLOW_URL,
	mlflowEmbedSrc,
	mlflowExternalUrl,
	normalizeEmbeddedAppPath,
} from "$lib/embedded-apps/links";

export const load: PageServerLoad = async ({ parent, params, url }) => {
	const layout = await parent();
	if (layout.platformRole !== "ADMIN") {
		throw error(403, "Admin access required");
	}

	const embedBase = publicEnv.PUBLIC_MLFLOW_EMBED_BASE?.trim() || DEFAULT_MLFLOW_EMBED_BASE;
	const externalBase = publicEnv.PUBLIC_MLFLOW_URL?.trim() || DEFAULT_MLFLOW_URL;
	const path = normalizeEmbeddedAppPath({ value: url.searchParams.get("path"), embedBase });

	return {
		slug: params.slug,
		path,
		embedBase,
		externalBase,
		iframeSrc: mlflowEmbedSrc({ embedBase, path }),
		externalHref: mlflowExternalUrl({ mlflowBase: externalBase, embedBase, path }),
	};
};
