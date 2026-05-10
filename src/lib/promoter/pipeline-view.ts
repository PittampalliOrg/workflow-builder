/**
 * Pure projection from a `PromotionStrategy` (with optional CTPs and PRs) into
 * a model the `PipelineView.svelte` component renders. Browser-safe: no
 * server-only imports, fully unit-testable.
 */
import type {
	ChangeTransferPolicy,
	Commit,
	CommitStatusEntry,
	EnvironmentStatus,
	HistoryEntry,
	PromotionStrategy,
	PullRequest,
} from "$lib/server/promoter/types";

export type EnvCardKind = "active-only" | "active-and-proposed";

export type CheckCounts = {
	total: number;
	success: number;
	pending: number;
	failure: number;
};

export type EnvCardModel = {
	branch: string;
	autoMerge: boolean;
	active: {
		dry: Commit | null;
		hydrated: Commit | null;
		commitStatuses: CommitStatusEntry[];
		checks: CheckCounts;
	};
	proposed: {
		dry: Commit | null;
		hydrated: Commit | null;
		commitStatuses: CommitStatusEntry[];
		checks: CheckCounts;
		pullRequest: PullRequest | null;
	} | null;
	history: HistoryEntry[];
};

export type PipelineViewModel = {
	strategy: PromotionStrategy;
	gitRepositoryName: string | null;
	envs: EnvCardModel[];
	overallPhase: "healthy" | "pending" | "failure" | "unknown";
};

export function summarizeChecks(statuses: CommitStatusEntry[] | undefined): CheckCounts {
	const counts: CheckCounts = { total: 0, success: 0, pending: 0, failure: 0 };
	for (const s of statuses ?? []) {
		counts.total += 1;
		if (s.phase === "success") counts.success += 1;
		else if (s.phase === "failure") counts.failure += 1;
		else counts.pending += 1;
	}
	return counts;
}

export function buildEnvCard(
	envSpec: NonNullable<PromotionStrategy["spec"]>["environments"] extends (infer E)[] | undefined
		? E
		: { branch: string; autoMerge?: boolean },
	envStatus: EnvironmentStatus | null,
	prByBranch: Map<string, PullRequest>,
): EnvCardModel {
	const branch = (envSpec as { branch: string }).branch;
	const autoMerge = (envSpec as { autoMerge?: boolean }).autoMerge ?? true;

	const active = envStatus?.active ?? {};
	const proposed = envStatus?.proposed ?? {};

	const activeStatuses = active.commitStatuses ?? [];
	const proposedStatuses = proposed.commitStatuses ?? [];

	const proposedDrySha = proposed.dry?.sha ?? null;
	const activeDrySha = active.dry?.sha ?? null;
	const showProposed = !!(proposedDrySha && proposedDrySha !== activeDrySha);

	return {
		branch,
		autoMerge,
		active: {
			dry: active.dry ?? null,
			hydrated: active.hydrated ?? null,
			commitStatuses: activeStatuses,
			checks: summarizeChecks(activeStatuses),
		},
		proposed: showProposed
			? {
					dry: proposed.dry ?? null,
					hydrated: proposed.hydrated ?? null,
					commitStatuses: proposedStatuses,
					checks: summarizeChecks(proposedStatuses),
					pullRequest: prByBranch.get(branch) ?? null,
				}
			: null,
		history: envStatus?.history ?? [],
	};
}

export function buildPipelineView(
	strategy: PromotionStrategy,
	options: {
		pullRequests?: PullRequest[];
		changeTransferPolicies?: ChangeTransferPolicy[];
	} = {},
): PipelineViewModel {
	const envSpecs = strategy.spec?.environments ?? [];
	const envStatuses = strategy.status?.environments ?? [];
	const statusByBranch = new Map(envStatuses.map((env) => [env.branch, env]));

	const prByBranch = new Map<string, PullRequest>();
	for (const pr of options.pullRequests ?? []) {
		const target = pr.spec?.targetBranch;
		if (target) prByBranch.set(target, pr);
	}

	const envs = envSpecs.map((spec) =>
		buildEnvCard(spec, statusByBranch.get(spec.branch) ?? null, prByBranch),
	);

	const overallPhase = computeOverallPhase(envs);

	return {
		strategy,
		gitRepositoryName: strategy.spec?.gitRepositoryRef?.name ?? null,
		envs,
		overallPhase,
	};
}

function computeOverallPhase(envs: EnvCardModel[]): PipelineViewModel["overallPhase"] {
	if (envs.length === 0) return "unknown";
	let anyPending = false;
	let anyFailure = false;
	for (const env of envs) {
		const checks = env.proposed ? env.proposed.checks : env.active.checks;
		if (checks.failure > 0) anyFailure = true;
		else if (env.proposed && checks.success < checks.total) anyPending = true;
	}
	if (anyFailure) return "failure";
	if (anyPending) return "pending";
	return "healthy";
}
