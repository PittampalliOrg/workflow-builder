/**
 * Compact projection of the hub inventory's promoter surface
 * (promotionStrategies / changeTransferPolicies / pullRequests) for the GitOps
 * overview strip: one linkified row per strategy with per-env-branch phase
 * chips, plus the open promotion PRs. Pure and unit-tested.
 */
import { buildPipelineView } from "$lib/promoter/pipeline-view";
import type {
	PromotionStrategiesResponse,
	PullRequest,
} from "$lib/server/promoter/types";

export type PulsePhase = "success" | "pending" | "failure" | "unknown";

export type PromotionPulseEnv = {
	branch: string;
	/** `env/spokes-dev` → `dev` for the chip label. */
	shortBranch: string;
	phase: PulsePhase;
	/** A proposed dry SHA differs from active — promotion in flight. */
	inFlight: boolean;
	prNumber: number | null;
	prUrl: string | null;
	branchUrl: string;
};

export type PromotionPulseRow = {
	name: string;
	phase: PulsePhase;
	envs: PromotionPulseEnv[];
};

export type OpenPromotionPr = {
	number: number | null;
	url: string | null;
	title: string | null;
	sourceBranch: string | null;
	targetBranch: string | null;
	state: string;
};

export type PromotionPulse = {
	rows: PromotionPulseRow[];
	openPrs: OpenPromotionPr[];
	changeTransferPolicyCount: number;
	totals: { success: number; pending: number; failure: number };
};

export function shortBranchName(branch: string): string {
	return branch.replace(/^env\/(spokes-)?/, "");
}

function prNumberOf(pr: PullRequest): number | null {
	const raw =
		pr.status?.id ??
		pr.metadata.labels?.["promoter.argoproj.io/pull-request-id"] ??
		null;
	if (raw == null) return null;
	const parsed = Number.parseInt(String(raw), 10);
	return Number.isFinite(parsed) ? parsed : null;
}

function prUrlOf(pr: PullRequest, stacksRepoUrl: string): string | null {
	const number = prNumberOf(pr);
	if (number == null) return null;
	return `${stacksRepoUrl.replace(/\/+$/, "")}/pull/${number}`;
}

export function buildPromotionPulse(
	promotions: PromotionStrategiesResponse,
	options: { stacksRepoUrl: string },
): PromotionPulse {
	const stacksRepoUrl = options.stacksRepoUrl.replace(/\/+$/, "");
	const totals = { success: 0, pending: 0, failure: 0 };

	const rows: PromotionPulseRow[] = promotions.strategies.map((strategy) => {
		const view = buildPipelineView(strategy, {
			pullRequests: promotions.pullRequests,
			changeTransferPolicies: promotions.changeTransferPolicies,
		});
		const envs: PromotionPulseEnv[] = view.envs.map((env) => {
			const inFlight = env.proposed != null;
			const checks = env.proposed?.checks ?? env.active.checks;
			const phase: PulsePhase =
				checks.failure > 0
					? "failure"
					: inFlight || checks.pending > 0
						? "pending"
						: checks.total > 0 || env.active.dry
							? "success"
							: "unknown";
			if (phase !== "unknown") totals[phase] += 1;
			const pr = env.proposed?.pullRequest ?? null;
			return {
				branch: env.branch,
				shortBranch: shortBranchName(env.branch),
				phase,
				inFlight,
				prNumber: pr ? prNumberOf(pr) : null,
				prUrl: pr ? prUrlOf(pr, stacksRepoUrl) : null,
				branchUrl: `${stacksRepoUrl}/tree/${env.branch}`,
			};
		});
		const phase: PulsePhase = envs.some((env) => env.phase === "failure")
			? "failure"
			: envs.some((env) => env.phase === "pending")
				? "pending"
				: envs.some((env) => env.phase === "success")
					? "success"
					: "unknown";
		return { name: strategy.metadata.name, phase, envs };
	});

	const openPrs: OpenPromotionPr[] = promotions.pullRequests
		.filter((pr) => (pr.spec?.state ?? "open") === "open")
		.map((pr) => ({
			number: prNumberOf(pr),
			url: prUrlOf(pr, stacksRepoUrl),
			title: pr.spec?.title ?? null,
			sourceBranch: pr.spec?.sourceBranch ?? null,
			targetBranch: pr.spec?.targetBranch ?? null,
			state: pr.spec?.state ?? "open",
		}));

	return {
		rows,
		openPrs,
		changeTransferPolicyCount: promotions.changeTransferPolicies.length,
		totals,
	};
}
