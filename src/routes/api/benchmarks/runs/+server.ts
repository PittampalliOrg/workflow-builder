import { error, json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import {
	createBenchmarkRun,
	getBenchmarkRun,
	listBenchmarkRuns,
	markBenchmarkRunStatus,
	startSwebenchCoordinator,
} from "$lib/server/benchmarks/service";

export const GET: RequestHandler = async ({ locals, url }) => {
	if (!locals.session?.userId) return error(401, "Authentication required");
	if (!locals.session.projectId) return json({ runs: [] });
	const limit = Number.parseInt(url.searchParams.get("limit") ?? "20", 10);
	const runs = await listBenchmarkRuns(locals.session.projectId, limit);
	return json({ runs });
};

export const POST: RequestHandler = async ({ request, locals }) => {
	if (!locals.session?.userId) return error(401, "Authentication required");
	if (!locals.session.projectId) {
		return error(400, "No active workspace — cannot create benchmark run");
	}
	const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
	const run = await createBenchmarkRun({
		projectId: locals.session.projectId,
		userId: locals.session.userId,
		suiteSlug: String(body.suiteSlug ?? body.suite ?? ""),
		agentId: String(body.agentId ?? ""),
		agentVersion:
			typeof body.agentVersion === "number"
				? body.agentVersion
				: body.agentVersion
					? Number.parseInt(String(body.agentVersion), 10)
					: undefined,
		instanceIds: body.instanceIds ?? body.selectedInstanceIds ?? "",
		modelNameOrPath:
			typeof body.modelNameOrPath === "string" ? body.modelNameOrPath : undefined,
		modelConfigLabel:
			typeof body.modelConfigLabel === "string" ? body.modelConfigLabel : null,
		concurrency:
			typeof body.concurrency === "number"
				? body.concurrency
				: body.concurrency
					? Number.parseInt(String(body.concurrency), 10)
					: undefined,
		timeoutSeconds:
			typeof body.timeoutSeconds === "number"
				? body.timeoutSeconds
				: body.timeoutSeconds
					? Number.parseInt(String(body.timeoutSeconds), 10)
					: undefined,
		maxTurns:
			typeof body.maxTurns === "number"
				? body.maxTurns
				: body.maxTurns
					? Number.parseInt(String(body.maxTurns), 10)
					: null,
		evaluatorResourceClass:
			typeof body.evaluatorResourceClass === "string"
				? body.evaluatorResourceClass
				: null,
	});

	let coordinatorStartError: string | null = null;
	try {
		const coordinator = await startSwebenchCoordinator(run.id);
		if (typeof coordinator.executionId === "string") {
			await markBenchmarkRunStatus(run.id, "inferencing", {
				coordinatorExecutionId: coordinator.executionId,
			});
		}
	} catch (err) {
		coordinatorStartError = err instanceof Error ? err.message : String(err);
		await markBenchmarkRunStatus(run.id, "failed", {
			error: coordinatorStartError,
		});
	}

	const fullRun = await getBenchmarkRun(locals.session.projectId, run.id);
	return json(
		{ run: fullRun, coordinatorStartError },
		{ status: 201 },
	);
};
