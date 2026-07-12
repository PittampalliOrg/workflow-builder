import { error, json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { getApplicationAdapters } from "$lib/server/application";
import { stopDurableRun } from "$lib/server/lifecycle";

/** Single dev environment detail (project-scoped). Tolerates the provisioning gap.
 * B5 additive: `services` lists EVERY per-service preview row for the execution
 * (a multi-service session has N); `environment` stays the primary row. */
export const GET: RequestHandler = async ({ params, locals }) => {
	if (!locals.session?.userId) return error(401, "Authentication required");
	const executionId = params.executionId!;
	const app = getApplicationAdapters();
	const workflowData = app.workflowData;
	const environment = await workflowData.getDevEnvironmentOrPending({
		executionId,
		projectId: locals.session.projectId,
	});
	if (!environment) return error(404, "Dev environment not found");
	const groups = await workflowData.listDevEnvironmentGroups({
		projectId: locals.session.projectId,
	});
	const services = groups.find((g) => g.executionId === executionId)
		?.services ?? [environment];
	return json({ environment, services });
};

/**
 * Tear down a dev environment: delete the preview Sandbox and purge the bound
 * interactive session through the vetted Lifecycle Controller (never hand-rolled
 * terminate). Project-scoped: the environment must belong to the caller's project.
 */
export const DELETE: RequestHandler = async ({ params, locals }) => {
	if (!locals.session?.userId) return error(401, "Authentication required");
	const executionId = params.executionId!;
	const app = getApplicationAdapters();
	const workflowData = app.workflowData;
	const scope = {
		executionId,
		projectId: locals.session.projectId,
	};
	const environment =
		(await workflowData.getDevEnvironmentOrPending(scope)) ??
		(await workflowData.getDevEnvironmentTeardownTarget(scope));
	if (!environment) return error(404, "Dev environment not found");

	const reason = "Dev environment torn down by user";
	// B5: no explicit sandboxName — the teardown loops EVERY per-service Sandbox
	// persisted for the execution. Passing the primary row's sandboxName here
	// used to strand sibling services' adopted prods at 0 replicas in
	// multi-service sessions (only one Sandbox was deleted/restored).
	const preview = await app.previewEnvironmentProvisioner.teardown({
		executionId,
	});
	const lifecycleErrors: string[] = [];

	const stop = async (target: {
		kind: "session" | "workflowExecution";
		id: string;
	}): Promise<string | null> => {
		try {
			const r = await stopDurableRun(target, { mode: "purge", reason });
			if (!["confirmed", "stopping", "notFound"].includes(r.state)) {
				throw new Error(`unexpected lifecycle state ${r.state}`);
			}
			return r.state;
		} catch (err) {
			const detail = err instanceof Error ? err.message : String(err);
			lifecycleErrors.push(`${target.kind}: ${detail}`);
			console.warn(
				`[dev-environments] ${target.kind} purge failed:`,
				detail,
			);
			return null;
		}
	};

	// Deferred response-path teardown must return before SEA removes the BFF/router.
	// A subsequent idempotent DELETE completes lifecycle cleanup after prod is restored.
	const sessionStopped =
		preview.complete && environment.sessionId
			? await stop({ kind: "session", id: environment.sessionId })
			: null;
	// If the run is still active (provisioning / kept-alive mid-run), cancel it.
	const runStopped =
		preview.complete &&
		environment.runStatus &&
		!["success", "error", "cancelled"].includes(environment.runStatus)
			? await stop({ kind: "workflowExecution", id: executionId })
			: null;
	const lifecyclePending = [sessionStopped, runStopped].includes("stopping");
	const ok = preview.ok && lifecycleErrors.length === 0;
	const pending = preview.pending || lifecyclePending;
	const complete = preview.complete && ok && !pending;

	return json(
		{
			ok,
			complete,
			pending,
			executionId,
			sandboxName: preview.sandboxName,
			sessionStopped,
			runStopped,
			...(lifecycleErrors.length
				? {
						error: `lifecycle cleanup failed: ${lifecycleErrors.join("; ")}`,
					}
				: {}),
		},
		{ status: !ok ? 503 : pending ? 202 : complete ? 200 : 503 },
	);
};
