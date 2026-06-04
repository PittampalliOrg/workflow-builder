export type GitCommitMetadata = {
	sha: string;
	shortSha: string;
	url: string;
	message: string | null;
	authorName: string | null;
	committedAt: string | null;
};

export type ParsedImageRef = {
	image: string;
	repository: string;
	name: string;
	tag: string | null;
	digest: string | null;
	commitSha: string | null;
};

export type DesiredImageMetadata = {
	name: string;
	tag: string;
	commitSha: string | null;
	commit: GitCommitMetadata | null;
	imageRef?: string | null;
	digest?: string | null;
	sourceSha?: string | null;
	pipelineRun?: string | null;
	updatedAt?: string | null;
};

export type LiveContainerMetadata = ParsedImageRef & {
	containerName: string;
	imageID: string | null;
	startedAt?: string | null;
	podStartedAt?: string | null;
	podCreatedAt?: string | null;
	ready: boolean | null;
	restartCount: number | null;
	desiredTag: string | null;
	desiredCommitSha: string | null;
	desiredMatches: boolean | null;
	commit: GitCommitMetadata | null;
	pinKey: string | null;
};

export type LiveDeploymentMetadata = {
	name: string;
	namespace: string;
	labels: Record<string, string>;
	replicas: number;
	readyReplicas: number;
	availableReplicas: number;
	updatedReplicas: number;
	createdAt?: string | null;
	updatedAt?: string | null;
	availableAt?: string | null;
	podStartedAt?: string | null;
	pods: {
		total: number;
		running: number;
		ready: number;
		names: string[];
	};
	containers: LiveContainerMetadata[];
};

export type GitOpsInventoryPromotion = {
	drySha: string | null;
	hydratedSha: string | null;
	healthPhase: string | null;
};

export type GitOpsInventoryBuild = {
	pipelineRun: string | null;
	status: string | null;
	reason: string | null;
	startedAt: string | null;
	finishedAt: string | null;
};

export type GitOpsInventoryImage = {
	image: string | null;
	tag: string | null;
	digest: string | null;
	commitSha: string | null;
};

export type GitOpsInventoryApplication = {
	name: string;
	component: string;
	desired: GitOpsInventoryImage;
	live: {
		images: string[];
		syncStatus: string | null;
		healthStatus: string | null;
	};
	promotion: GitOpsInventoryPromotion | null;
	build: GitOpsInventoryBuild | null;
	provenance: Record<string, string> | null;
	drift: {
		status: "in_sync" | "pending_rollout" | "unknown" | string;
	};
};

export type GitOpsInventoryEnvironment = {
	name: string;
	applications: GitOpsInventoryApplication[];
};

export type GitOpsDeploymentInventory = {
	generatedAt: string;
	source: string;
	releasePins: {
		images: Record<string, string>;
		error: string | null;
	};
	environments: GitOpsInventoryEnvironment[];
};

export type DeploymentMetadataResponse = {
	generatedAt: string;
	environment: {
		name: string;
		namespace: string;
		appUrl: string | null;
		nodeEnv: string | null;
		podName: string | null;
		detectedFrom?: string;
	};
	gitops: {
		releasePinsSourceUrl: string;
		releasePinsFetchedAt: string | null;
		releasePinsError: string | null;
		stacksMain: GitCommitMetadata | null;
		desiredImages: DesiredImageMetadata[];
	};
	live: {
		deployments: LiveDeploymentMetadata[];
		error: string | null;
	};
	inventory: {
		sourceUrl: string | null;
		fetchedAt: string | null;
		error: string | null;
		data: GitOpsDeploymentInventory | null;
	};
};

export type RuntimeImageMetadata = {
	deploymentName: string;
	containerName: string;
	image: string;
	repository: string;
	name: string;
	tag: string | null;
	digest: string | null;
	imageID: string | null;
	commitSha: string | null;
	commitUrl: string | null;
	commitMessage: string | null;
	committedAt: string | null;
	ready: boolean | null;
	restartCount: number | null;
	desiredTag: string | null;
	desiredMatches: boolean | null;
};

export type RuntimeEnvironmentMetadata = DeploymentMetadataResponse["environment"] & {
	detectedFrom: string;
};

export type RuntimeMatrixRow = {
	environment: string;
	applicationName: string;
	component: string;
	desiredImage: string | null;
	desiredTag: string | null;
	desiredCommitSha: string | null;
	liveImage: string | null;
	liveTag: string | null;
	liveCommitSha: string | null;
	syncStatus: string | null;
	healthStatus: string | null;
	driftStatus: string | null;
	promotionHealth: string | null;
	buildReason: string | null;
	buildStatus: string | null;
	buildFinishedAt: string | null;
	generatedAt: string | null;
};

export type RuntimeMetadataResponse = {
	generatedAt: string;
	environment: RuntimeEnvironmentMetadata;
	current: RuntimeImageMetadata | null;
	matrix: RuntimeMatrixRow[];
	errors: string[];
};
