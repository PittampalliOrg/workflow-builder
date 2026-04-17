import { error, json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import {
	addResource,
	listResources,
	type AddResourceInput,
} from "$lib/server/sessions/registry";
import type { SessionResourceType } from "$lib/types/sessions";

export const GET: RequestHandler = async ({ params, locals }) => {
	if (!locals.session?.userId) return error(401, "Authentication required");
	const resources = await listResources(params.id);
	return json({ resources });
};

export const POST: RequestHandler = async ({ params, request, locals }) => {
	if (!locals.session?.userId) return error(401, "Authentication required");
	const body = (await request.json().catch(() => ({}))) as Record<
		string,
		unknown
	>;
	const type = body.type as SessionResourceType | undefined;
	if (type !== "file" && type !== "github_repository") {
		return error(400, "type must be 'file' or 'github_repository'");
	}
	const input: AddResourceInput = {
		type,
		fileId: typeof body.fileId === "string" ? body.fileId : undefined,
		mountPath: typeof body.mountPath === "string" ? body.mountPath : undefined,
		repoUrl: typeof body.repoUrl === "string" ? body.repoUrl : undefined,
		checkoutRef:
			typeof body.checkoutRef === "string" ? body.checkoutRef : undefined,
		authTokenCredentialId:
			typeof body.authTokenCredentialId === "string"
				? body.authTokenCredentialId
				: undefined,
	};
	const resource = await addResource(params.id, input);
	return json({ resource }, { status: 201 });
};
