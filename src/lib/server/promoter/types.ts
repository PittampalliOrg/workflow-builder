/**
 * Type definitions mirroring promoter.argoproj.io/v1alpha1 CRDs as projected
 * by the hub `gitops-deployment-inventory` aggregator. These follow the upstream
 * CRD shapes documented at https://gitops-promoter.readthedocs.io/en/latest/crd-specs/
 * and the TypeScript declarations at
 * https://github.com/argoproj-labs/gitops-promoter/blob/main/ui/shared/src/types/promotion.ts
 */

export type PromoterPhase = "pending" | "success" | "failure" | string;

export type Commit = {
	sha: string;
	repoURL?: string | null;
	author?: string | null;
	subject?: string | null;
	body?: string | null;
	commitTime?: string | null;
	references?: Array<{ commit?: { sha: string; repoURL?: string } }>;
};

export type CommitStatusEntry = {
	key: string;
	phase: PromoterPhase;
	url?: string | null;
	description?: string | null;
};

export type CommitState = {
	dry?: Commit | null;
	hydrated?: Commit | null;
	commitStatuses?: CommitStatusEntry[];
};

export type HistoryEntry = {
	active?: { dry?: Commit | null; hydrated?: Commit | null };
	proposed?: { hydrated?: Commit | null; commitStatuses?: CommitStatusEntry[] };
	pullRequest?: { number?: number; url?: string; state?: string } | null;
	endedAt?: string | null;
};

export type EnvironmentStatus = {
	branch: string;
	active?: CommitState;
	proposed?: CommitState;
	lastHealthyDryShas?: Array<{ sha: string; time?: string }>;
	history?: HistoryEntry[];
};

export type PromotionStrategySpec = {
	gitRepositoryRef?: { name?: string; namespace?: string };
	activeCommitStatuses?: Array<{ key: string }>;
	proposedCommitStatuses?: Array<{ key: string }>;
	environments?: Array<{
		branch: string;
		autoMerge?: boolean;
		activeCommitStatuses?: Array<{ key: string }>;
		proposedCommitStatuses?: Array<{ key: string }>;
	}>;
};

export type PromotionStrategy = {
	apiVersion?: string;
	kind?: "PromotionStrategy";
	metadata: {
		name: string;
		namespace: string;
		uid?: string;
		labels?: Record<string, string>;
		annotations?: Record<string, string>;
		creationTimestamp?: string;
	};
	spec?: PromotionStrategySpec;
	status?: {
		environments?: EnvironmentStatus[];
		conditions?: Array<{ type: string; status: string; reason?: string; message?: string; lastTransitionTime?: string }>;
	};
};

/**
 * ChangeTransferPolicy mirrors PromotionStrategy.status.environments[i] for a
 * single env. Optional in our payload; the views can render fully from
 * PromotionStrategy alone, but ChangeTransferPolicy gives access to richer
 * proposed-commit detail when desired.
 */
export type ChangeTransferPolicy = {
	apiVersion?: string;
	kind?: "ChangeTransferPolicy";
	metadata: {
		name: string;
		namespace: string;
		uid?: string;
		labels?: Record<string, string>;
		ownerReferences?: Array<{ kind: string; name: string; uid?: string }>;
	};
	spec?: {
		activeBranch?: string;
		proposedBranch?: string;
		autoMerge?: boolean;
	};
	status?: {
		active?: CommitState;
		proposed?: CommitState;
		conditions?: Array<{ type: string; status: string; reason?: string; message?: string; lastTransitionTime?: string }>;
	};
};

export type PullRequest = {
	apiVersion?: string;
	kind?: "PullRequest";
	metadata: { name: string; namespace: string; labels?: Record<string, string> };
	spec?: {
		sourceBranch: string;
		targetBranch: string;
		title?: string;
		state?: "open" | "closed" | "merged" | string;
	};
	status?: {
		id?: string | number;
		observedGeneration?: number;
		conditions?: Array<{ type: string; status: string; reason?: string; message?: string }>;
	};
};

export type CommitStatus = {
	apiVersion?: string;
	kind?: "CommitStatus";
	metadata: { name: string; namespace: string; labels?: Record<string, string> };
	spec?: {
		sha: string;
		name: string;
		phase?: PromoterPhase;
		url?: string;
		description?: string;
	};
	status?: {
		phase?: PromoterPhase;
		sha?: string;
		id?: string | number;
	};
};

/**
 * Top-level shape we expect to find on `inventory.data.promotionStrategies` once
 * the hub aggregator's Phase-A change is in place. All sub-arrays are optional
 * so the workflow-builder client can degrade gracefully on older inventories
 * (Phase A may not have rolled to all envs yet).
 */
export type PromoterInventory = {
	schemaVersion?: number;
	promotionStrategies: PromotionStrategy[];
	changeTransferPolicies?: ChangeTransferPolicy[];
	pullRequests?: PullRequest[];
	commitStatuses?: CommitStatus[];
};

export type PromotionStrategiesResponse = {
	generatedAt: string | null;
	source: "hub-inventory" | "fixture" | "empty";
	strategies: PromotionStrategy[];
	changeTransferPolicies: ChangeTransferPolicy[];
	pullRequests: PullRequest[];
	commitStatuses: CommitStatus[];
	error: string | null;
};
