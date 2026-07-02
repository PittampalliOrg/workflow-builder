import { getApplicationAdapters } from "$lib/server/application";
import type { PageServerLoad } from "./$types";

export const load: PageServerLoad = async ({ locals, url }) => {
	const baseUrl = `${url.protocol}//${url.host}`;

	if (!locals.session?.userId) {
		return { profile: null, baseUrl, oauthApps: [] };
	}

	const settings = await getApplicationAdapters().workflowData.getSettingsPageReadModel({
		userId: locals.session.userId,
		sessionPlatformId: locals.session.platformId,
	});

	return {
		...settings,
		baseUrl,
	};
};
