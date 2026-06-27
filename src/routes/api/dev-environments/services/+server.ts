import { error, json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { devPreviewServiceCatalog } from "$lib/server/workflows/dev-environments";

/**
 * Credential-free catalog of launchable dev-preview services. Drives the launch
 * dialog's service dropdown + the read-only "Dapr-shadow" badge.
 */
export const GET: RequestHandler = async ({ locals }) => {
	if (!locals.session?.userId) return error(401, "Authentication required");
	return json({ services: devPreviewServiceCatalog() });
};
