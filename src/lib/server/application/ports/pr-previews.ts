import type {
	ImmutableGitSha,
	PreviewEnvironmentLaunchOutcome,
	PreviewEnvironmentLaunchSpec
} from './preview-environments';

/** GitHub truth used by the PR automation lane. No webhook field is authority. */
export type VerifiedPrPreviewPullRequest = Readonly<{
	repository: string;
	prNumber: number;
	baseRef: 'main';
	baseSha: ImmutableGitSha;
	headSha: ImmutableGitSha;
	changedPaths: readonly string[];
}>;

export interface PrPreviewPullRequestPort {
	/**
	 * Verify an open, same-repository PR against the canonical repository and
	 * base branch configured by the adapter. The adapter must compare the exact
	 * expected head SHA and return the complete, bounded changed-path set.
	 */
	inspect(input: {
		prNumber: number;
		expectedHeadSha: string;
	}): Promise<VerifiedPrPreviewPullRequest>;
	/** Create-or-update the single comment carrying `marker` on the PR. */
	upsertStickyComment(input: { prNumber: number; marker: string; body: string }): Promise<boolean>;
}

/** Narrow application-to-application port for the unified domain launch. */
export interface PrPreviewEnvironmentLaunchPort {
	launch(input: PreviewEnvironmentLaunchSpec): Promise<PreviewEnvironmentLaunchOutcome>;
}

export type PrPreviewDevPodResult = {
	service: string;
	ok: boolean;
	podIp: string | null;
	syncPort: number | null;
	/** Exact execution/service agent-action leaf minted by the adopted BFF. */
	syncCapability: string | null;
	error?: string;
};

export interface PrPreviewDevPodPort {
	/** Adopt only the selected preview-native services inside the environment. */
	provision(input: {
		previewUrl: string;
		alias: string;
		services: string[];
		syncToken: string;
		requestId: string;
		platformRevision: ImmutableGitSha;
		sourceRevision: ImmutableGitSha;
		catalogDigest: `sha256:${string}`;
	}): Promise<PrPreviewDevPodResult[]>;
}

export type PrPreviewSeedTarget = {
	service: string;
	/** Repo subdir the service's sync tree is rooted at (`.` for the BFF). */
	repoSubdir: string;
	syncPaths: string[];
	extraSync: Array<{ from: string; to: string }>;
	podIp: string;
	syncPort: number;
	/** Exact child leaf for this target; never a preview-wide mint capability. */
	syncToken: string;
	/** Dev-server app port; falls back to syncPort when omitted. */
	appPort?: number;
	healthPath?: string;
};

export interface PrPreviewSeedPort {
	/** Seed the already-verified immutable PR head into every selected dev pod. */
	seed(input: {
		prNumber: number;
		headSha: string;
		targets: PrPreviewSeedTarget[];
	}): Promise<{ ok: boolean; detail: string | null }>;
}

export interface PrPreviewVerifyPort {
	start(input: { prNumber: number; previewUrl: string; headSha: string }): Promise<{
		started: boolean;
		executionId?: string | null;
		reason?: string | null;
	}>;
	waitForVerdict(input: {
		executionId: string;
		timeoutMs: number;
	}): Promise<{ status: string; verdict: string | null }>;
}

/** Static sync metadata; changed-path classification is owned by the catalog port. */
export type PrPreviewRegistryEntry = {
	service: string;
	repoSubdir: string;
	syncPaths: string[];
	extraSync: Array<{ from: string; to: string }>;
	appPort?: number;
	healthPath?: string;
};

/** Server-derived facts persisted before any detached work starts. */
export type PrPreviewAuthority = Readonly<{
	repository: string;
	baseRef: 'main';
	baseSha: ImmutableGitSha;
	headSha: ImmutableGitSha;
	changedPaths: readonly string[];
	services: readonly string[];
	platformRepository: string;
	platformRevision: ImmutableGitSha;
	catalogDigest: `sha256:${string}`;
	requestId: string;
	requestedAt: string;
}>;

export type PrPreviewState =
	| 'provisioning'
	| 'seeding'
	| 'ready'
	| 'tearing_down'
	| 'error'
	| 'capacity_full';

export type PrPreviewRecord = {
	prNumber: number;
	alias: string;
	url: string | null;
	state: PrPreviewState;
	headSha: string | null;
	services: string[];
	/** Null only for legacy rows created before the unified authority migration. */
	authority: PrPreviewAuthority | null;
	error: string | null;
	verify: PrPreviewStatus['verify'];
	gen: number;
	updatedAt: string;
};

export interface PrPreviewRecordStore {
	get(prNumber: number): Promise<PrPreviewRecord | null>;
	upsert(record: Omit<PrPreviewRecord, 'gen' | 'updatedAt'>): Promise<PrPreviewRecord>;
	patch(
		prNumber: number,
		gen: number,
		changes: Partial<Omit<PrPreviewRecord, 'prNumber' | 'gen' | 'updatedAt'>>
	): Promise<boolean>;
	/** Delete only the caller's generation when supplied, preventing ABA races. */
	delete(prNumber: number, gen?: number): Promise<boolean>;
	listActive(): Promise<PrPreviewRecord[]>;
	claimStale(prNumber: number, staleMs: number): Promise<PrPreviewRecord | null>;
}

export type PrPreviewStatus = {
	prNumber: number;
	alias: string;
	url: string | null;
	state: PrPreviewState | 'absent' | 'unknown';
	headSha: string | null;
	services: string[];
	error: string | null;
	verify: {
		state: 'started' | 'skipped' | 'completed' | 'failed';
		executionId: string | null;
		reason: string | null;
		verdict: string | null;
	} | null;
	updatedAt: string | null;
};

/** Commands crossing from the persistent compatibility BFF to immutable control. */
export interface PrPreviewCommandPort {
	up(
		input: Readonly<{
			prNumber: number;
			headSha: string;
			verify?: boolean;
		}>
	): Promise<PrPreviewStatus>;
	down(
		input: Readonly<{
			prNumber: number;
		}>
	): Promise<{ state: 'down' | 'absent' }>;
	status(prNumber: number): Promise<PrPreviewStatus>;
}
