import { error, json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { BenchmarkAgentValidationError } from "$lib/server/benchmarks/agents";
import { getBenchmarkLaunchCapacityDiagnostics } from "$lib/server/benchmarks/capacity-diagnostics";

export const POST: RequestHandler = async ({ request, locals }) => {
	if (!locals.session?.userId) return error(401, "Authentication required");
	if (!locals.session.projectId) {
		return error(400, "No active workspace — cannot inspect benchmark capacity");
	}
	const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
	try {
		const diagnostics = await getBenchmarkLaunchCapacityDiagnostics({
			projectId: locals.session.projectId,
			agentId: String(body.agentId ?? ""),
			agentVersion:
				typeof body.agentVersion === "number"
					? body.agentVersion
					: body.agentVersion
						? Number.parseInt(String(body.agentVersion), 10)
						: undefined,
			instanceIds: body.instanceIds,
			instanceCount: body.instanceCount,
			requestedConcurrency:
				typeof body.requestedConcurrency === "number"
					? body.requestedConcurrency
					: body.requestedConcurrency
						? Number.parseInt(String(body.requestedConcurrency), 10)
						: body.concurrency,
			evaluationConcurrency:
				typeof body.evaluationConcurrency === "number"
					? body.evaluationConcurrency
					: body.evaluationConcurrency
						? Number.parseInt(String(body.evaluationConcurrency), 10)
						: undefined,
			modelNameOrPath:
				typeof body.modelNameOrPath === "string" ? body.modelNameOrPath : null,
			modelConfigLabel:
				typeof body.modelConfigLabel === "string" ? body.modelConfigLabel : null,
		});
		return json({ diagnostics });
	} catch (err) {
		if (err instanceof BenchmarkAgentValidationError) {
			return json({ message: err.message }, { status: 400 });
		}
		throw err;
	}
};
