/**
 * Cross-strategy projection: takes a list of `PromotionStrategy` resources and
 * produces sortable rows for the Inbox tab. Pure, browser-safe, unit-testable.
 */
import type { PromotionStrategy, PullRequest } from "$lib/server/promoter/types";

import { buildPipelineView } from "./pipeline-view";

export type InboxPhase = "healthy" | "pending" | "failure" | "unknown";

export type InboxRow = {
	name: string;
	namespace: string;
	gitRepositoryName: string | null;
	phase: InboxPhase;
	envCount: number;
	stuckOn: {
		branch: string;
		failingChecks: string[];
		pendingChecks: string[];
		pullRequestUrl: string | null;
	} | null;
	latestDryShaShort: string | null;
	latestDrySubject: string | null;
	latestDryFullSha: string | null;
	latestActivity: string | null;
};

const PHASE_RANK: Record<InboxPhase, number> = {
	failure: 0,
	pending: 1,
	unknown: 2,
	healthy: 3,
};

export function buildInboxRow(
	strategy: PromotionStrategy,
	options: { pullRequests?: PullRequest[] } = {},
): InboxRow {
	const view = buildPipelineView(strategy, options);
	const envs = view.envs;

	// Pick the first env that has anything to flag. Prefer proposed-pane
	// signals (a promotion in flight) when present; otherwise consider
	// active-pane signals (the env itself is still settling — e.g., the
	// final env's soak timer hasn't elapsed yet).
	const stuckEnv = envs.find((env) => {
		if (env.proposed && env.proposed.checks.failure > 0) return true;
		if (env.proposed && env.proposed.checks.pending > 0) return true;
		if (env.active.checks.failure > 0) return true;
		if (env.active.checks.pending > 0) return true;
		return false;
	});

	const stuckOn = stuckEnv
		? (() => {
				// If proposed has any non-success checks, surface those.
				const proposedNonGreen = stuckEnv.proposed?.commitStatuses.some(
					(c) => c.phase !== "success",
				);
				const source = proposedNonGreen
					? stuckEnv.proposed!.commitStatuses
					: stuckEnv.active.commitStatuses;
				return {
					branch: stuckEnv.branch,
					failingChecks: source.filter((c) => c.phase === "failure").map((c) => c.key),
					pendingChecks: source.filter((c) => c.phase === "pending").map((c) => c.key),
					pullRequestUrl:
						stuckEnv.proposed?.pullRequest && proposedNonGreen
							? deriveUrl(stuckEnv.proposed.pullRequest)
							: null,
				};
			})()
		: null;

	const latestEnv = envs[0];
	const latestActive = latestEnv?.active;
	const latestDry = latestActive?.dry ?? null;
	const latestActivity = pickLatestTime(envs);

	return {
		name: strategy.metadata.name,
		namespace: strategy.metadata.namespace,
		gitRepositoryName: view.gitRepositoryName,
		phase: view.overallPhase,
		envCount: envs.length,
		stuckOn,
		latestDryShaShort: latestDry?.sha ? latestDry.sha.slice(0, 8) : null,
		latestDrySubject: latestDry?.subject ?? null,
		latestDryFullSha: latestDry?.sha ?? null,
		latestActivity,
	};
}

export function buildInboxRows(
	strategies: PromotionStrategy[],
	options: { pullRequests?: PullRequest[] } = {},
): InboxRow[] {
	return strategies.map((strategy) => buildInboxRow(strategy, options));
}

export type InboxSortKey = "lastUpdated" | "name" | "phase";
export type InboxSortDirection = "asc" | "desc";

export function sortInboxRows(
	rows: InboxRow[],
	sortKey: InboxSortKey = "lastUpdated",
	direction: InboxSortDirection = "desc",
): InboxRow[] {
	const factor = direction === "asc" ? 1 : -1;
	const sorted = [...rows];
	sorted.sort((a, b) => {
		switch (sortKey) {
			case "phase":
				return (PHASE_RANK[a.phase] - PHASE_RANK[b.phase]) * factor;
			case "name":
				return a.name.localeCompare(b.name) * factor;
			case "lastUpdated":
			default: {
				const at = a.latestActivity ? new Date(a.latestActivity).getTime() : 0;
				const bt = b.latestActivity ? new Date(b.latestActivity).getTime() : 0;
				return (at - bt) * factor;
			}
		}
	});
	return sorted;
}

function deriveUrl(pr: PullRequest): string | null {
	// Promoter's PullRequest CR doesn't carry the SCM URL directly. We surface
	// `null` here and let the link helper rebuild from `repoBrowseUrl + pr.id`
	// if needed in the component.
	const id = pr.status?.id ?? pr.metadata.labels?.["promoter.argoproj.io/pull-request-id"] ?? null;
	if (id == null) return null;
	return `pr-id:${id}`;
}

function pickLatestTime(envs: ReturnType<typeof buildPipelineView>["envs"]): string | null {
	let best: number | null = null;
	for (const env of envs) {
		const t = env.active.dry?.commitTime ?? env.active.hydrated?.commitTime;
		if (t) {
			const n = new Date(t).getTime();
			if (!Number.isNaN(n) && (best == null || n > best)) best = n;
		}
	}
	return best != null ? new Date(best).toISOString() : null;
}
