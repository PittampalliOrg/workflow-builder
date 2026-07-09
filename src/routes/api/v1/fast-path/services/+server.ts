import { error, json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { getApplicationAdapters } from "$lib/server/application";

export const GET: RequestHandler = async ({ locals }) => {
	if (!locals.session?.userId) return error(401, "Authentication required");
	const app = getApplicationAdapters();
	const services = await app.workflowData.listDevPreviewServices();
	return json({
		services,
		capabilities: {
			preview: ["ensure", "adopt", "status", "teardown"],
			sync: {
				contentTypes: ["application/gzip", "application/octet-stream"],
				maxBytes: 50 * 1024 * 1024,
			},
			run: "registry-allowlisted",
			promote: ["latest-source-bundle", "artifact-id"],
		},
	});
};
