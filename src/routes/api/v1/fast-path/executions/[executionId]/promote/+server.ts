import { error, json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { getApplicationAdapters } from "$lib/server/application";

export const POST: RequestHandler = async ({ params, request, locals }) => {
	if (!locals.session?.userId) return error(401, "Authentication required");
	const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
	const app = getApplicationAdapters();
	const versions = await app.workflowCodeVersions.listVersions({
		executionId: params.executionId,
		userId: locals.session.userId,
		projectId: locals.session.projectId ?? null,
	});
	if (versions.status === "error") return error(versions.httpStatus, versions.message);

	const requestedArtifactId =
		typeof body.artifactId === "string" && body.artifactId.trim()
			? body.artifactId.trim()
			: null;
	const artifactId = requestedArtifactId ?? versions.body.versions.at(-1)?.artifactId;
	if (!artifactId) return error(404, "No source-bundle version found");

	const { artifactId: _artifactId, ...promotionBody } = body;
	const result = await app.workflowCodeVersionPromotion.promote({
		executionId: params.executionId,
		artifactId,
		userId: locals.session.userId,
		projectId: locals.session.projectId ?? null,
		body: promotionBody,
	});
	if (result.status === "error") return error(result.httpStatus, result.message);
	return json(result.body, { status: result.httpStatus ?? 200 });
};
