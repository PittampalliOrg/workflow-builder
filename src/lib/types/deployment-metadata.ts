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
};

export type LiveContainerMetadata = ParsedImageRef & {
	containerName: string;
	imageID: string | null;
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
	pods: {
		total: number;
		running: number;
		ready: number;
		names: string[];
	};
	containers: LiveContainerMetadata[];
};

export type DeploymentMetadataResponse = {
	generatedAt: string;
	environment: {
		name: string;
		namespace: string;
		appUrl: string | null;
		nodeEnv: string | null;
		podName: string | null;
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
};
