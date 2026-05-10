/**
 * Timeline projection: flattens `status.environments[].history[]` into entries
 * sortable by event time, with cross-env lineage edges that connect the same
 * dry SHA as it propagates from one env (e.g., dev) to the next (staging).
 *
 * Pure, browser-safe, unit-testable. The SVG curve drawing happens in
 * `TimelineLineage.svelte` based on the edges this projection emits.
 */
import type {
	CommitStatusEntry,
	HistoryEntry,
	PromotionStrategy,
} from "$lib/server/promoter/types";

export type TimelineEntry = {
	id: string;
	branch: string;
	dryShaFull: string | null;
	dryShaShort: string | null;
	dryRepoUrl: string | null;
	subject: string | null;
	author: string | null;
	endedAt: string | null;
	finalPhase: "success" | "failure" | "pending" | "unknown";
	pullRequest: { number?: number; url?: string; state?: string } | null;
	commitStatuses: CommitStatusEntry[];
};

export type TimelineEdge = {
	fromId: string;
	toId: string;
	dryShaFull: string;
};

export type TimelineViewModel = {
	branches: string[];
	entriesByBranch: Record<string, TimelineEntry[]>;
	edges: TimelineEdge[];
};

export function buildTimelineView(
	strategy: PromotionStrategy,
	options: { showOnlyFailed?: boolean } = {},
): TimelineViewModel {
	const envs = strategy.status?.environments ?? [];
	const branches = envs.map((env) => env.branch);

	const entriesByBranch: Record<string, TimelineEntry[]> = {};
	const idsByDrySha = new Map<string, Array<{ branch: string; id: string; index: number }>>();

	envs.forEach((env, branchIndex) => {
		const entries: TimelineEntry[] = [];
		(env.history ?? []).forEach((history, idx) => {
			const entry = projectHistoryEntry(env.branch, idx, history);
			if (options.showOnlyFailed && entry.finalPhase !== "failure") return;
			entries.push(entry);
			if (entry.dryShaFull) {
				const arr = idsByDrySha.get(entry.dryShaFull) ?? [];
				arr.push({ branch: env.branch, id: entry.id, index: branchIndex });
				idsByDrySha.set(entry.dryShaFull, arr);
			}
		});
		entriesByBranch[env.branch] = entries.sort((a, b) =>
			compareIsoDesc(a.endedAt, b.endedAt),
		);
	});

	const edges: TimelineEdge[] = [];
	for (const [sha, occurrences] of idsByDrySha) {
		// Connect the same dry SHA across consecutive envs (dev → staging, etc.).
		const sorted = [...occurrences].sort((a, b) => a.index - b.index);
		for (let i = 0; i < sorted.length - 1; i++) {
			edges.push({ fromId: sorted[i].id, toId: sorted[i + 1].id, dryShaFull: sha });
		}
	}

	return { branches, entriesByBranch, edges };
}

function projectHistoryEntry(
	branch: string,
	index: number,
	history: HistoryEntry,
): TimelineEntry {
	const activeDry = history.active?.dry ?? null;
	const activeHydrated = history.active?.hydrated ?? null;
	const proposed = history.proposed ?? null;
	const statuses = proposed?.commitStatuses ?? [];
	const finalPhase = derivePhase(statuses);

	const dryShaFull = activeDry?.sha ?? null;

	return {
		id: `${branch}#${index}#${dryShaFull ?? "no-sha"}`,
		branch,
		dryShaFull,
		dryShaShort: dryShaFull ? dryShaFull.slice(0, 8) : null,
		dryRepoUrl: activeDry?.repoURL ?? activeHydrated?.repoURL ?? null,
		subject: activeDry?.subject ?? null,
		author: activeDry?.author ?? null,
		endedAt: history.endedAt ?? activeHydrated?.commitTime ?? activeDry?.commitTime ?? null,
		finalPhase,
		pullRequest: history.pullRequest ?? null,
		commitStatuses: statuses,
	};
}

function derivePhase(statuses: CommitStatusEntry[]): TimelineEntry["finalPhase"] {
	if (statuses.length === 0) return "unknown";
	if (statuses.some((s) => s.phase === "failure")) return "failure";
	if (statuses.every((s) => s.phase === "success")) return "success";
	return "pending";
}

function compareIsoDesc(a: string | null, b: string | null): number {
	const at = a ? new Date(a).getTime() : 0;
	const bt = b ? new Date(b).getTime() : 0;
	return bt - at;
}
