import { error, json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { getApplicationAdapters } from "$lib/server/application";
import { PreviewAccessDeniedError } from "$lib/server/application/preview-access";
import { PreviewRuntimeIdentityChangedError } from "$lib/server/application/vcluster-previews";

export const GET: RequestHandler = async ({ params, locals }) => {
	const actorUserId = locals.session?.userId;
	if (!actorUserId) return error(401, "Authentication required");
	const adapters = getApplicationAdapters();
	if (!adapters.previewDeploymentScope.allowsPreviewName(params.name)) {
		return error(403, "Cross-preview access is unavailable from a preview deployment");
	}
	try {
		return json({
			runtime: await adapters.vclusterPreviews.observeRuntime({
				name: params.name,
				actorUserId
			})
		});
	} catch (cause) {
		if (cause instanceof PreviewAccessDeniedError) return error(403, cause.message);
		if (cause instanceof PreviewRuntimeIdentityChangedError) return error(409, cause.message);
		throw cause;
	}
};
