import { error, json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { getApplicationAdapters } from "$lib/server/application";
import type {
	UpsertWorkspaceSessionInput,
	WorkspaceSessionBackend,
	WorkspaceSessionStatus,
} from "$lib/server/application/ports";
import { requireInternal } from "$lib/server/internal-auth";

type IncomingWorkspaceSession = Partial<UpsertWorkspaceSessionInput>;

const VALID_BACKENDS = new Set<WorkspaceSessionBackend>(["openshell", "juicefs"]);
const VALID_STATUSES = new Set<WorkspaceSessionStatus>([
	"active",
	"cleaned",
	"error",
]);

function normalizeString(value: unknown): string | null {
	return typeof value === "string" && value.trim() ? value.trim() : null;
}

export const POST: RequestHandler = async ({ request }) => {
	requireInternal(request);
	const body = (await request.json().catch(() => null)) as IncomingWorkspaceSession | null;
	if (!body || typeof body !== "object" || Array.isArray(body)) {
		return error(400, "JSON object body required");
	}

	const workspaceRef = normalizeString(body.workspaceRef);
	const name = normalizeString(body.name);
	const rootPath = normalizeString(body.rootPath);
	const backend = normalizeString(body.backend);
	if (!workspaceRef || !name || !rootPath || !backend) {
		return error(400, "workspaceRef, name, rootPath, and backend are required");
	}
	if (!VALID_BACKENDS.has(backend as WorkspaceSessionBackend)) {
		return error(400, "backend must be one of openshell, juicefs");
	}
	const status = normalizeString(body.status) ?? "active";
	if (!VALID_STATUSES.has(status as WorkspaceSessionStatus)) {
		return error(400, "status must be one of active, cleaned, error");
	}
	const enabledTools = Array.isArray(body.enabledTools)
		? body.enabledTools.map((tool) => String(tool)).filter(Boolean)
		: [];

	const result = await getApplicationAdapters().workflowData.upsertWorkflowWorkspaceSession({
		workspaceRef,
		workflowExecutionId: normalizeString(body.workflowExecutionId),
		durableInstanceId: normalizeString(body.durableInstanceId),
		name,
		rootPath,
		clonePath: normalizeString(body.clonePath),
		backend: backend as WorkspaceSessionBackend,
		enabledTools,
		status: status as WorkspaceSessionStatus,
		sandboxState:
			body.sandboxState && typeof body.sandboxState === "object" && !Array.isArray(body.sandboxState)
				? (body.sandboxState as Record<string, unknown>)
				: null,
	});

	return json({ ok: true, ...result });
};
