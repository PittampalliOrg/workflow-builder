import { error, json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { openshellRuntimeFetch } from "$lib/server/openshell-runtime";
import { deleteKubernetesSandbox } from "$lib/server/kube/client";
import { getApplicationAdapters } from "$lib/server/application";
import { inspectDurableRun } from "$lib/server/lifecycle";
import { isResourceInScope } from "$lib/server/workflows/project-scope";

type DeleteResult = {
	name: string;
	kind: "runtime" | "workspace";
	status: "deleted" | "missing" | "error";
	error?: string;
};

async function deleteWorkspaceSandbox(name: string): Promise<DeleteResult> {
	try {
		const response = await openshellRuntimeFetch(
			`/api/v1/sandboxes/${encodeURIComponent(name)}`,
			{ method: "DELETE" },
		);
		if (response.ok) {
			return { name, kind: "workspace", status: "deleted" };
		}
		const detail = await response.text().catch(() => "");
		if (
			response.status === 404 ||
			detail.toLowerCase().includes("sandbox not found")
		) {
			return { name, kind: "workspace", status: "missing" };
		}
		return {
			name,
			kind: "workspace",
			status: "error",
			error:
				detail.slice(0, 500) ||
				response.statusText ||
				`HTTP ${response.status}`,
		};
	} catch (err) {
		return {
			name,
			kind: "workspace",
			status: "error",
			error: err instanceof Error ? err.message : String(err),
		};
	}
}

async function deleteRuntimeSandbox(name: string): Promise<DeleteResult> {
	try {
		const status = await deleteKubernetesSandbox(name);
		return {
			name,
			kind: "runtime",
			status: status === "deleted" ? "deleted" : "missing",
		};
	} catch (err) {
		return {
			name,
			kind: "runtime",
			status: "error",
			error: err instanceof Error ? err.message : String(err),
		};
	}
}

export const DELETE: RequestHandler = async ({ params, locals }) => {
	if (!locals.session?.userId) return error(401, "Authentication required");

	// Reaping a per-session Sandbox CR is exactly what stopDurableRun(mode:'purge')
	// does as its FINAL step after confirming the run is terminal. Doing it
	// standalone on a LIVE run yanks the pod out from under the session_workflow and
	// creates the DB↔Dapr divergence the lifecycle SSOT exists to prevent. So enforce
	// CMA scope and refuse while the run is active — stop it first (POST .../stop).
	const target = { kind: "session" as const, id: params.id };
	const inspected = await inspectDurableRun(target);
	if (inspected.notFound) return error(404, "Session not found");
	if (inspected.scope && !isResourceInScope(inspected.scope, locals.session)) {
		return error(404, "Session not found");
	}
	if (inspected.active) {
		return error(
			409,
			"Stop the run before destroying its sandbox (POST /api/v1/sessions/[id]/stop {mode:'purge'})",
		);
	}

	const session = await getApplicationAdapters().workflowData.getSessionDetail({
		sessionId: params.id,
		projectId: locals.session.projectId ?? null,
		userId: locals.session.userId,
	});
	if (!session) return error(404, "Session not found");

	const targets: Array<{ name: string; kind: DeleteResult["kind"] }> = [];
	if (session.runtimeSandboxName) {
		targets.push({ name: session.runtimeSandboxName, kind: "runtime" });
	}
	if (
		session.workspaceSandboxName &&
		session.workspaceSandboxName !== session.runtimeSandboxName
	) {
		targets.push({ name: session.workspaceSandboxName, kind: "workspace" });
	}

	if (targets.length === 0) {
		return json(
			{
				ok: false,
				error: "session_sandbox_delete_not_supported",
				message: "This session does not have a per-session sandbox to destroy.",
			},
			{ status: 409 },
		);
	}

	const results: DeleteResult[] = [];
	for (const target of targets) {
		results.push(
			target.kind === "runtime"
				? await deleteRuntimeSandbox(target.name)
				: await deleteWorkspaceSandbox(target.name),
		);
	}

	const errors = results.filter((result) => result.status === "error");
	if (errors.length > 0) {
		return json(
			{
				ok: false,
				error: "session_sandbox_delete_failed",
				message: "Failed to destroy one or more session sandboxes.",
				results,
			},
			{ status: 502 },
		);
	}

	return json({
		ok: true,
		deleted: results.some((result) => result.status === "deleted"),
		results,
	});
};
