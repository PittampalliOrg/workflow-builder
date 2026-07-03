import { error, json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { getApplicationAdapters } from "$lib/server/application";
import type { SessionStatus } from "$lib/types/sessions";

export const GET: RequestHandler = async ({ url, locals }) => {
	if (!locals.session?.userId) return error(401, "Authentication required");
	const agentId = url.searchParams.get("agentId") ?? undefined;
	const status = url.searchParams.get("status") as SessionStatus | null;
	const sourceParam = url.searchParams.get("source") as
		| "direct"
		| "workflow"
		| "api"
		| null;
	const workflowId = url.searchParams.get("workflowId") ?? undefined;
	const executionId = url.searchParams.get("executionId") ?? undefined;
	const q = url.searchParams.get("q") ?? undefined;
	const includeArchived = url.searchParams.get("includeArchived") === "true";
	const limitParam = url.searchParams.get("limit");
	const limit = limitParam ? Number.parseInt(limitParam, 10) : undefined;
	const sessions = await getApplicationAdapters().sessionCommands.listSessions({
		userId: locals.session.userId,
		projectId: locals.session.projectId,
		agentId,
		status: status ?? undefined,
		source: sourceParam ?? undefined,
		workflowId,
		executionId,
		q,
		includeArchived,
		limit: Number.isFinite(limit) ? limit : undefined,
	});
	return json({ sessions });
};

export const POST: RequestHandler = async ({ request, locals }) => {
	if (!locals.session?.userId) return error(401, "Authentication required");
	const body = (await request.json().catch(() => ({}))) as Record<
		string,
		unknown
	>;
	const result =
		await getApplicationAdapters().sessionCommands.createInteractiveSession({
			userId: locals.session.userId,
			projectId: locals.session.projectId ?? null,
			body,
		});

	switch (result.status) {
		case "created":
			return json({ session: result.session }, { status: 201 });
		case "precondition_failed":
			return json(
				{
					code: result.code,
					provider: result.provider,
					settingsPath: result.settingsPath,
					message: result.message,
					session: result.session,
				},
				{ status: 412 },
			);
		case "not_found":
			return error(404, result.message);
		case "conflict":
			return error(409, result.message);
		case "invalid":
			return error(400, result.message);
	}
};
