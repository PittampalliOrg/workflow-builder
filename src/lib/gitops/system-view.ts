/**
 * Promotion-evidence helpers shared by the GitOps pipeline view model
 * (`pipeline-model.ts`). The previous hard-coded single-image pipeline view
 * (`buildGitopsSystemViewModel` + `GitopsPipeline*` types) was superseded by the
 * Kargo-style multi-pipeline model and has been retired.
 */
import { buildPipelineView, type EnvCardModel } from "$lib/promoter/pipeline-view";
import type {
	CommitStatusEntry,
	PromotionStrategiesResponse,
	PullRequest,
} from "$lib/server/promoter/types";

export type SystemTone = "healthy" | "pending" | "failure" | "unknown";

export type SystemPromotionEvidence = {
	name: string;
	tone: SystemTone;
	activeBranch: string | null;
	activeDrySha: string | null;
	activeHydratedSha: string | null;
	pendingChecks: string[];
	failingChecks: string[];
	updatedAt: string | null;
	envBranches: string[];
};

export type SystemCheckEvidence = {
	name: string;
	phase: string | null;
	description: string | null;
	url: string | null;
	branch: string | null;
};

export type PromotionGate = {
	key: string;
	phase: string | null;
	description: string | null;
};

/**
 * Parsed soak-timer progress from a Promoter `timer` CommitStatus description
 * like `"soaking 4m of 10m"`. `null` when the description isn't a soak countdown.
 */
export type SoakProgress = {
	elapsed: string;
	total: string;
	label: string;
};

/**
 * Per-environment promotion state derived from `buildPipelineView`'s
 * `EnvCardModel`. Unlike the single collapsed `SystemPromotionEvidence.tone`,
 * this preserves the proposed-vs-active distinction the Promoter actually
 * tracks, so the dev stage can show an in-flight badge, the waiting gate, the
 * soak countdown, and the promotion PR.
 */
export type EnvPromotionState = {
	branch: string;
	autoMerge: boolean;
	/** A promotion is in flight when a distinct `proposed` dry sha exists. */
	inFlight: boolean;
	activeDrySha: string | null;
	activeHydratedSha: string | null;
	/** Proposed (next) hydrated sha when a promotion is in flight, else null. */
	proposedDrySha: string | null;
	proposedHydratedSha: string | null;
	/**
	 * The gates to render. When a promotion is in flight these are the proposed
	 * pane's checks (the gates the next freight must clear); otherwise the active
	 * pane's checks (this env's own stabilization gates).
	 */
	gates: PromotionGate[];
	/** First pending/failing gate key — what delivery is blocked on. */
	stalledOn: string | null;
	/** Parsed soak countdown when a `timer` gate carries one. */
	soak: SoakProgress | null;
	pullRequest: { url: string | null; state: string | null } | null;
	updatedAt: string | null;
};

export function summarizePromotion(
	promotions: PromotionStrategiesResponse,
	name: string,
): SystemPromotionEvidence | null {
	const strategy = promotions.strategies.find((candidate) => candidate.metadata.name === name);
	if (!strategy) return null;

	const view = buildPipelineView(strategy, {
		changeTransferPolicies: promotions.changeTransferPolicies,
		pullRequests: promotions.pullRequests,
	});
	const active = view.envs[0]?.active ?? null;
	const allStatuses = view.envs.flatMap((env) => [
		...env.active.commitStatuses,
		...(env.proposed?.commitStatuses ?? []),
	]);

	return {
		name,
		tone: view.overallPhase,
		activeBranch: view.envs[0]?.branch ?? null,
		activeDrySha: active?.dry?.sha ?? null,
		activeHydratedSha: active?.hydrated?.sha ?? null,
		pendingChecks: allStatuses.filter((status) => status.phase === "pending").map((status) => status.key),
		failingChecks: allStatuses.filter((status) => status.phase === "failure").map((status) => status.key),
		updatedAt:
			active?.dry?.commitTime ??
			active?.hydrated?.commitTime ??
			view.envs[0]?.history?.[0]?.endedAt ??
			null,
		envBranches: view.envs.map((env) => env.branch),
	};
}

export function findWorkflowBuilderSoak(
	promotions: PromotionStrategiesResponse,
): SystemCheckEvidence | null {
	for (const status of promotions.commitStatuses) {
		const name = status.metadata.name;
		const specName = status.spec?.name;
		if (name.includes("workflow-builder-soak") || specName === "workflow-builder-soak") {
			return {
				name: "workflow-builder-soak",
				phase: status.status?.phase ?? status.spec?.phase ?? null,
				description: null,
				url: status.spec?.url ?? null,
				branch: status.metadata.labels?.["promoter.argoproj.io/environment"] ?? null,
			};
		}
	}

	const strategy = promotions.strategies.find(
		(candidate) => candidate.metadata.name === "workflow-builder-release",
	);
	for (const environment of strategy?.status?.environments ?? []) {
		const timer =
			environment.proposed?.commitStatuses?.find((status) => status.key === "timer") ??
			environment.active?.commitStatuses?.find((status) => status.key === "timer");
		if (!timer) continue;
		return {
			name: "workflow-builder-soak",
			phase: timer.phase,
			description: timer.description ?? null,
			url: timer.url ?? null,
			branch: environment.branch,
		};
	}

	return null;
}

export function parseSoakTimer(description: string | null | undefined): SoakProgress | null {
	if (!description) return null;
	const text = description.trim();
	// "soaking 4m of 10m" / "4m of 10m" / "soaking 4m / 10m"
	const ofMatch = text.match(/(\d+[smhd])\s*(?:of|\/)\s*(\d+[smhd])/i);
	if (ofMatch) {
		const [, elapsed, total] = ofMatch;
		return { elapsed, total, label: `${elapsed} of ${total}` };
	}
	// "soaked for 10m" / "soaked 10m"
	const soakedMatch = text.match(/soaked(?:\s+for)?\s+(\d+[smhd])/i);
	if (soakedMatch) {
		const [, total] = soakedMatch;
		return { elapsed: total, total, label: total };
	}
	return null;
}

function gatesFromStatuses(statuses: CommitStatusEntry[]): PromotionGate[] {
	return statuses.map((status) => ({
		key: status.key,
		phase: status.phase ?? null,
		description: status.description ?? null,
	}));
}

/** First pending then first failing gate key — the thing delivery is waiting on. */
function firstStalledGate(gates: PromotionGate[]): string | null {
	const pending = gates.find((gate) => gate.phase === "pending");
	if (pending) return pending.key;
	const failing = gates.find((gate) => gate.phase === "failure");
	if (failing) return failing.key;
	return null;
}

function soakFromGates(gates: PromotionGate[]): SoakProgress | null {
	const timer = gates.find((gate) => gate.key === "timer");
	return parseSoakTimer(timer?.description);
}

function prFromEnvCard(card: EnvCardModel): EnvPromotionState["pullRequest"] {
	const pr: PullRequest | null = card.proposed?.pullRequest ?? null;
	if (!pr) return null;
	const url = prUrl(pr);
	const state = pr.spec?.state ?? null;
	if (!url && !state) return null;
	return { url, state };
}

function prUrl(pr: PullRequest): string | null {
	// The promoter PullRequest CR doesn't carry a canonical html_url field; the
	// id (when numeric) lets a consumer build a link, but we surface only what's
	// present to avoid fabricating URLs. Most deployments stamp the URL via an
	// annotation, so prefer that when available.
	const annotated =
		(pr.metadata.labels?.["promoter.argoproj.io/pull-request-url"] as string | undefined) ?? null;
	return annotated ?? null;
}

function toEnvPromotionState(card: EnvCardModel): EnvPromotionState {
	const inFlight = card.proposed !== null;
	const gates = gatesFromStatuses(
		inFlight ? card.proposed!.commitStatuses : card.active.commitStatuses,
	);
	return {
		branch: card.branch,
		autoMerge: card.autoMerge,
		inFlight,
		activeDrySha: card.active.dry?.sha ?? null,
		activeHydratedSha: card.active.hydrated?.sha ?? null,
		proposedDrySha: card.proposed?.dry?.sha ?? null,
		proposedHydratedSha: card.proposed?.hydrated?.sha ?? null,
		gates,
		stalledOn: firstStalledGate(gates),
		soak: soakFromGates(gates),
		pullRequest: inFlight ? prFromEnvCard(card) : null,
		updatedAt:
			card.proposed?.dry?.commitTime ??
			card.active.dry?.commitTime ??
			card.active.hydrated?.commitTime ??
			card.history?.[0]?.endedAt ??
			null,
	};
}

/**
 * Per-environment promotion state keyed by env branch. The sibling of
 * `summarizePromotion` that preserves the proposed-vs-active distinction
 * (C1): the model layer indexes this by branch so each Promoter-gated stage
 * (e.g. dev) carries its own `{ inFlight, gates, stalledOn, soak, pullRequest }`
 * instead of a single collapsed `overallPhase`.
 */
export function summarizeEnvPromotions(
	promotions: PromotionStrategiesResponse,
	name: string,
): Map<string, EnvPromotionState> {
	const out = new Map<string, EnvPromotionState>();
	const strategy = promotions.strategies.find((candidate) => candidate.metadata.name === name);
	if (!strategy) return out;

	const view = buildPipelineView(strategy, {
		changeTransferPolicies: promotions.changeTransferPolicies,
		pullRequests: promotions.pullRequests,
	});
	for (const card of view.envs) {
		out.set(card.branch, toEnvPromotionState(card));
	}
	return out;
}
