import { error } from "@sveltejs/kit";
import { listBenchmarkRuns } from "$lib/server/benchmarks/service";
import { loadCompareData } from "$lib/server/benchmarks/comparison";
import type { PageServerLoad } from "./$types";

export const load: PageServerLoad = async ({ url, locals }) => {
	if (!locals.session?.userId) error(401, "Authentication required");
	if (!locals.session.projectId) error(400, "No active workspace");

	const runsParam = url.searchParams.get("runs") ?? "";
	let runIds = runsParam
		.split(",")
		.map((s) => s.trim())
		.filter(Boolean);

	// `?tag=foo` expands to the most-recent (up to 4) runs that share the tag.
	// Useful for the launch flow: tag a matrix of runs with the same label,
	// then `/compare?tag=foo` opens them side-by-side without typing run IDs.
	const tag = url.searchParams.get("tag")?.trim() || null;
	let resolvedFromTag: string | null = tag;
	if (runIds.length === 0 && tag) {
		const tagged = await listBenchmarkRuns(locals.session.projectId, 100, {
			tag,
		});
		runIds = tagged.slice(0, 4).map((r) => r.id);
	}

	if (runIds.length === 0) {
		return {
			compare: null as Awaited<ReturnType<typeof loadCompareData>> | null,
			runIds: [],
			resolvedFromTag,
		};
	}

	if (runIds.length === 1) {
		// One run isn't a comparison; return as-is so the page can render its
		// "pick another run" call-to-action without throwing.
		return {
			compare: null as Awaited<ReturnType<typeof loadCompareData>> | null,
			runIds,
			resolvedFromTag,
		};
	}

	const compare = await loadCompareData(locals.session.projectId, runIds);
	return { compare, runIds, resolvedFromTag };
};
