export type EnvironmentBuildActivityOptions = {
	sync?: boolean;
	forceTerminal?: boolean;
};

export type BenchmarkRunEnvironmentActivityOptions = {
	syncActive?: boolean;
};

export type EnvironmentBuildActivityEvent = {
	id: string;
	buildId: string;
	environmentKey: string;
	eventKey: string;
	eventType: string;
	pipelineRunName: string | null;
	pipelineRunNamespace: string | null;
	taskRunName: string | null;
	phase: string | null;
	reason: string | null;
	message: string | null;
	timestamp: string;
	rawMetadata: Record<string, unknown>;
	createdAt: string;
	updatedAt: string;
};

export type EnvironmentBuildSnapshot = {
	id: string;
	dataset: string;
	suite: string | null;
	repo: string;
	version: string | null;
	environmentSetupCommit: string | null;
	baseCommit: string | null;
	environmentKey: string;
	envSpecHash: string;
	buildStrategy: string;
	workspaceRoot: string | null;
	condaEnvironment: string | null;
	swebenchSpec: Record<string, unknown> | null;
	status: string;
	sandboxTemplate: string;
	sandboxImage: string | null;
	digest: string | null;
	imageName: string | null;
	imageTag: string | null;
	dockerfilePath: string | null;
	validationCommand: string | null;
	validationStatus: string | null;
	validationLogRef: string | null;
	buildLogRef: string | null;
	pipelineRunName: string | null;
	pipelineRunNamespace: string | null;
	pipelineRunUrl: string | null;
	error: string | null;
	requestedAt: string;
	startedAt: string | null;
	completedAt: string | null;
	builtAt: string | null;
	createdAt: string;
	updatedAt: string;
};

export type EnvironmentBuildActivityResponse = {
	build: EnvironmentBuildSnapshot;
	events: EnvironmentBuildActivityEvent[];
	latestEvent: EnvironmentBuildActivityEvent | null;
	syncError?: string;
};

export type BenchmarkRunEnvironmentActivityResponse = {
	runId: string;
	instances: Array<{
		runInstanceId: string;
		instanceId: string;
		build: EnvironmentBuildSnapshot | null;
		events: EnvironmentBuildActivityEvent[];
		latestEvent: EnvironmentBuildActivityEvent | null;
	}>;
};

export interface EnvironmentBuildActivityReadPort {
	getBuildActivity(
		buildId: string,
		options?: EnvironmentBuildActivityOptions,
	): Promise<EnvironmentBuildActivityResponse | null>;
	getBenchmarkRunActivity(
		projectId: string,
		runId: string,
		options?: BenchmarkRunEnvironmentActivityOptions,
	): Promise<BenchmarkRunEnvironmentActivityResponse | null>;
}

export class ApplicationEnvironmentBuildActivityService {
	constructor(private readonly readPort: EnvironmentBuildActivityReadPort) {}

	getBuildActivity(
		buildId: string,
		options: EnvironmentBuildActivityOptions = {},
	): Promise<EnvironmentBuildActivityResponse | null> {
		return this.readPort.getBuildActivity(buildId, options);
	}

	getBenchmarkRunActivity(
		projectId: string,
		runId: string,
		options: BenchmarkRunEnvironmentActivityOptions = {},
	): Promise<BenchmarkRunEnvironmentActivityResponse | null> {
		return this.readPort.getBenchmarkRunActivity(projectId, runId, options);
	}
}
