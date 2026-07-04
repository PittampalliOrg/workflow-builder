import { error, json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { requireInternal } from "$lib/server/internal-auth";
import { getApplicationAdapters } from "$lib/server/application";
import type { BenchmarkResourceLeaseTypeInput } from "$lib/server/application/benchmark-route-operations";

function resourceTypes(value: unknown): BenchmarkResourceLeaseTypeInput[] | null {
	if (!Array.isArray(value)) return null;
	return value.filter(
		(v): v is BenchmarkResourceLeaseTypeInput =>
			v === "inference_slot" ||
			v === "openshell_sandbox" ||
			v === "agent_runtime_slot" ||
			v === "dapr_workflow_slot" ||
			v === "evaluator_slot" ||
			v === "model_slot",
	);
}

export const GET: RequestHandler = async ({ request, params }) => {
	requireInternal(request);
	return json(
		await getApplicationAdapters().benchmarkRouteOperations.leaseSnapshot(
			params.runId,
		),
	);
};

export const POST: RequestHandler = async ({ request, params }) => {
	requireInternal(request);
	const body = (await request.json().catch(() => null)) as Record<
		string,
		unknown
	> | null;
	if (!body) return error(400, "JSON body required");
	const action = typeof body.action === "string" ? body.action : "acquire";
	const operations = getApplicationAdapters().benchmarkRouteOperations;
	if (action === "release") {
		return json({
			success: true,
			...(await operations.releaseLeases({
				runId: params.runId,
				instanceId:
					typeof body.instanceId === "string" ? body.instanceId : null,
				holderId: typeof body.holderId === "string" ? body.holderId : null,
				phase: typeof body.phase === "string" ? body.phase : null,
				resources: resourceTypes(body.resources),
				reason: typeof body.reason === "string" ? body.reason : null,
			})),
		});
	}
	if (action !== "acquire") return error(400, `Unsupported lease action: ${action}`);
	return json({
		success: true,
		...(await operations.acquireLeases({
			runId: params.runId,
			instanceId:
				typeof body.instanceId === "string" ? body.instanceId : null,
			phase: typeof body.phase === "string" ? body.phase : null,
			resources: resourceTypes(body.resources),
			leaseSeconds:
				typeof body.leaseSeconds === "number"
					? body.leaseSeconds
					: typeof body.leaseSeconds === "string"
						? Number.parseInt(body.leaseSeconds, 10)
						: null,
			metadata:
				body.metadata && typeof body.metadata === "object" && !Array.isArray(body.metadata)
					? (body.metadata as Record<string, unknown>)
					: null,
		})),
	});
};
