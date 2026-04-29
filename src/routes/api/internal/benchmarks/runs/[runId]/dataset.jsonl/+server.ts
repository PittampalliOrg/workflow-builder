import { error } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { requireInternal } from "$lib/server/internal-auth";
import { buildSwebenchDatasetJsonlForRunById } from "$lib/server/benchmarks/service";

export const GET: RequestHandler = async ({ request, params }) => {
	requireInternal(request);
	const jsonl = await buildSwebenchDatasetJsonlForRunById(params.runId);
	if (!jsonl) return error(404, "Benchmark run not found");
	return new Response(jsonl, {
		headers: {
			"Content-Type": "application/jsonl; charset=utf-8",
			"Cache-Control": "no-store",
		},
	});
};
