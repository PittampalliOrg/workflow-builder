import { error } from "@sveltejs/kit";
import type { PageServerLoad } from "./$types";
import { getApplicationAdapters } from "$lib/server/application";

export type {
	BenchmarkRunDetailPageData as RunDetailPageData,
} from "$lib/server/application/benchmark-run-detail";

export const load: PageServerLoad = async ({ params, locals }) => {
	if (!locals.session?.userId) error(401, "Authentication required");
	const result = await getApplicationAdapters().benchmarkRunDetail.load({
		projectId: locals.session.projectId,
		runId: params.runId,
	});
	if (result.status === "not_found") error(404, result.message);
	return result.data;
};
