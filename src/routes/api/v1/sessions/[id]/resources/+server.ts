import { error, json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { getApplicationAdapters } from "$lib/server/application";
import type { AddSessionResourceInput } from "$lib/server/application/ports";
import { provisionSessionSandboxWithRetry } from "$lib/server/sandboxes/provision";
import { mountSingleRepository } from "$lib/server/sessions/repositories";
import type {
	SessionDetail,
	SessionResource,
	SessionResourceType,
} from "$lib/types/sessions";

export const GET: RequestHandler = async ({ params, locals }) => {
	if (!locals.session?.userId) return error(401, "Authentication required");
	const resources = await getApplicationAdapters().workflowData.listSessionResources({
		sessionId: params.id,
		projectId: locals.session.projectId ?? null,
		userId: locals.session.userId,
	});
	if (!resources) return error(404, "Session not found");
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
	const input: AddSessionResourceInput = {
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
		appConnectionExternalId:
			typeof body.appConnectionExternalId === "string"
				? body.appConnectionExternalId
				: undefined,
	};
	const result = await getApplicationAdapters().workflowData.addSessionResource({
		sessionId: params.id,
		resource: input,
		projectId: locals.session.projectId ?? null,
		userId: locals.session.userId,
	});
	if (result.status === "not_found") return error(404, "Session not found");
	const { resource, session } = result;

	// Mid-session mount: if a repo is added to a session that already has a
	// live sandbox, clone it in now. Sessions without a sandbox yet get their
	// repos cloned at spawn time by mountSessionRepositories. Best-effort and
	// awaited so the response reflects mount success/failure via the event log.
	if (resource.type === "github_repository") {
		try {
			await mountRepoIntoLiveSession(session, resource);
		} catch (mountErr) {
			console.warn("[sessions] mid-session repo mount failed:", mountErr);
		}
	}

	return json({ resource }, { status: 201 });
};

/**
 * Clone a repo into an already-running session's sandbox. Recovers the
 * sandbox's workspaceRef via an idempotent re-provision (a cheap hit when the
 * sandbox is already up — same executionId + name returns the same sandbox).
 */
async function mountRepoIntoLiveSession(
	session: SessionDetail,
	resource: SessionResource,
): Promise<void> {
	// No sandbox yet → leave it for the spawn-time mount.
	if (!session.workspaceSandboxName) return;
	let workspaceRef: string | null = null;
	let rootPath = "/sandbox";
	try {
		const sandbox = await provisionSessionSandboxWithRetry({
			executionId: session.id,
			name: session.title ?? `session-${session.id.slice(0, 8)}`,
			keepAfterRun: true,
		});
		workspaceRef = sandbox.workspaceRef;
		rootPath = sandbox.rootPath;
	} catch (provErr) {
		console.warn(
			"[sessions] could not recover sandbox workspaceRef for mid-session mount:",
			provErr,
		);
	}
	await mountSingleRepository(session.id, resource, {
		executionId: session.id,
		workspaceRef,
		rootPath,
	});
}
