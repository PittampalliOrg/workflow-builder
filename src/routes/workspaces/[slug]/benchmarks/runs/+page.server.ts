import { error } from "@sveltejs/kit";
import { listBenchmarkRuns } from "$lib/server/benchmarks/service";
import type { PageServerLoad } from "./$types";

export const load: PageServerLoad = async ({ locals }) => {
	if (!locals.session?.userId) error(401, "Authentication required");
	if (!locals.session.projectId) {
		return { runs: [], suiteOptions: [], agentOptions: [], modelOptions: [] };
	}

	const runs = await listBenchmarkRuns(locals.session.projectId, 100);

	const suiteSet = new Map<string, { slug: string; name: string; count: number }>();
	const agentSet = new Map<string, { id: string; name: string; slug: string | null; count: number }>();
	const modelSet = new Map<string, number>();
	const tagSet = new Map<string, number>();
	for (const r of runs) {
		const sb = suiteSet.get(r.suiteSlug) ?? { slug: r.suiteSlug, name: r.suiteName, count: 0 };
		sb.count += 1;
		suiteSet.set(r.suiteSlug, sb);
		const ag = agentSet.get(r.agentName) ?? {
			id: r.agentName,
			name: r.agentName,
			slug: r.agentSlug,
			count: 0,
		};
		ag.count += 1;
		agentSet.set(r.agentName, ag);
		modelSet.set(r.modelNameOrPath, (modelSet.get(r.modelNameOrPath) ?? 0) + 1);
		for (const tag of r.tags ?? []) {
			tagSet.set(tag, (tagSet.get(tag) ?? 0) + 1);
		}
	}

	return {
		runs,
		suiteOptions: [...suiteSet.values()].sort((a, b) => b.count - a.count),
		agentOptions: [...agentSet.values()].sort((a, b) => b.count - a.count),
		modelOptions: [...modelSet.entries()]
			.map(([model, count]) => ({ model, count }))
			.sort((a, b) => b.count - a.count),
		tagOptions: [...tagSet.entries()]
			.map(([tag, count]) => ({ tag, count }))
			.sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag)),
	};
};
