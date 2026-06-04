import { buildPipelineView } from "$lib/promoter/pipeline-view";
import type { PromotionStrategiesResponse } from "$lib/server/promoter/types";
import type {
	DeploymentMetadataResponse,
	DesiredImageMetadata,
	GitOpsInventoryApplication,
	LiveContainerMetadata,
	LiveDeploymentMetadata,
} from "$lib/types/deployment-metadata";
import { commitShaFromTag } from "$lib/utils/gitops-display";

export type SystemTone = "healthy" | "pending" | "failure" | "unknown";

export type SystemApplicationStatus = {
	name: string;
	component: string;
	environment: string;
	syncStatus: string | null;
	healthStatus: string | null;
	driftStatus: string | null;
	tag: string | null;
	commitSha: string | null;
	liveImage: string | null;
	buildPipelineRun: string | null;
	buildReason: string | null;
	buildStatus: string | null;
	buildFinishedAt: string | null;
	promotionHealth: string | null;
	hydratedSha: string | null;
};

export type SystemBuildEvidence = {
	environment: string;
	applicationName: string;
	component: string;
	pipelineRun: string;
	status: string | null;
	reason: string | null;
	startedAt: string | null;
	finishedAt: string | null;
	tag: string | null;
	commitSha: string | null;
};

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

export type SystemLiveImage = {
	deployment: string;
	namespace: string;
	container: string;
	image: string;
	tag: string | null;
	commitSha: string | null;
	ready: boolean | null;
	restartCount: number | null;
};

export type GitopsSystemViewModel = {
	currentEnvironment: string;
	currentWorkflowBuilderLive: SystemLiveImage | null;
	activeWorkflowBuilderPin: DesiredImageMetadata | null;
	rootRyzen: SystemApplicationStatus | null;
	ryzenWorkflowBuilder: SystemApplicationStatus | null;
	devWorkflowBuilder: SystemApplicationStatus | null;
	latestOuterLoopBuild: SystemBuildEvidence | null;
	workflowBuilderRelease: SystemPromotionEvidence | null;
	workflowBuilderSoak: SystemCheckEvidence | null;
	stagingDormant: boolean;
	errors: string[];
};

export function buildGitopsSystemViewModel(
	metadata: DeploymentMetadataResponse,
	promotions: PromotionStrategiesResponse,
): GitopsSystemViewModel {
	const workflowBuilderRelease = summarizePromotion(promotions, "workflow-builder-release");

	return {
		currentEnvironment: metadata.environment.name ?? "unknown",
		currentWorkflowBuilderLive: findCurrentWorkflowBuilderLive(metadata.live.deployments),
		activeWorkflowBuilderPin:
			metadata.gitops.desiredImages.find((pin) => pin.name === "workflow-builder") ?? null,
		rootRyzen: findApplication(metadata, {
			name: "root-ryzen",
			environment: "ryzen",
		}),
		ryzenWorkflowBuilder: findApplication(metadata, {
			name: "ryzen-workflow-builder",
			component: "workflow-builder",
			environment: "ryzen",
		}),
		devWorkflowBuilder: findApplication(metadata, {
			name: "dev-workflow-builder",
			component: "workflow-builder",
			environment: "dev",
		}),
		latestOuterLoopBuild: findLatestBuild(metadata),
		workflowBuilderRelease,
		workflowBuilderSoak: findWorkflowBuilderSoak(promotions),
		stagingDormant: !workflowBuilderRelease?.envBranches.includes("env/spokes-staging"),
		errors: [
			metadata.live.error,
			metadata.gitops.releasePinsError,
			metadata.inventory.error,
			promotions.error,
		].filter((message): message is string => Boolean(message)),
	};
}

function findCurrentWorkflowBuilderLive(
	deployments: LiveDeploymentMetadata[],
): SystemLiveImage | null {
	const deployment =
		deployments.find((candidate) => candidate.name === "workflow-builder") ??
		deployments.find((candidate) =>
			candidate.containers.some((container) => container.name === "workflow-builder"),
		);
	if (!deployment) return null;

	const container =
		deployment.containers.find((candidate) => candidate.containerName === "workflow-builder") ??
		deployment.containers.find((candidate) => candidate.name === "workflow-builder") ??
		deployment.containers.find((candidate) => !candidate.containerName.startsWith("init/"));
	if (!container) return null;

	return liveImageFromContainer(deployment, container);
}

function liveImageFromContainer(
	deployment: LiveDeploymentMetadata,
	container: LiveContainerMetadata,
): SystemLiveImage {
	return {
		deployment: deployment.name,
		namespace: deployment.namespace,
		container: container.containerName,
		image: container.image,
		tag: container.tag,
		commitSha: container.commitSha,
		ready: container.ready,
		restartCount: container.restartCount,
	};
}

function findApplication(
	metadata: DeploymentMetadataResponse,
	criteria: {
		name?: string;
		component?: string;
		environment?: string;
	},
): SystemApplicationStatus | null {
	for (const environment of metadata.inventory.data?.environments ?? []) {
		if (criteria.environment && environment.name !== criteria.environment) continue;
		for (const application of environment.applications) {
			if (criteria.name && application.name === criteria.name) {
				return applicationStatus(environment.name, application);
			}
			if (
				criteria.component &&
				application.component === criteria.component &&
				(!criteria.name || application.name.endsWith(criteria.name))
			) {
				return applicationStatus(environment.name, application);
			}
		}
	}

	if (criteria.environment === metadata.environment.name && criteria.component === "workflow-builder") {
		const live = findCurrentWorkflowBuilderLive(metadata.live.deployments);
		if (!live) return null;
		return {
			name: `${criteria.environment}-workflow-builder`,
			component: "workflow-builder",
			environment: criteria.environment,
			syncStatus: null,
			healthStatus: live.ready === false ? "NotReady" : live.ready === true ? "Healthy" : null,
			driftStatus: null,
			tag: live.tag,
			commitSha: live.commitSha,
			liveImage: live.image,
			buildPipelineRun: null,
			buildReason: null,
			buildStatus: null,
			buildFinishedAt: null,
			promotionHealth: null,
			hydratedSha: null,
		};
	}

	return null;
}

function applicationStatus(
	environment: string,
	application: GitOpsInventoryApplication,
): SystemApplicationStatus {
	return {
		name: application.name,
		component: application.component,
		environment,
		syncStatus: application.live.syncStatus,
		healthStatus: application.live.healthStatus,
		driftStatus: application.drift.status,
		tag: application.desired.tag,
		commitSha: application.desired.commitSha ?? commitShaFromTag(application.desired.tag),
		liveImage: application.live.images[0] ?? null,
		buildPipelineRun: application.build?.pipelineRun ?? null,
		buildReason: application.build?.reason ?? null,
		buildStatus: application.build?.status ?? null,
		buildFinishedAt: application.build?.finishedAt ?? null,
		promotionHealth: application.promotion?.healthPhase ?? null,
		hydratedSha: application.promotion?.hydratedSha ?? null,
	};
}

function findLatestBuild(metadata: DeploymentMetadataResponse): SystemBuildEvidence | null {
	let latest: SystemBuildEvidence | null = null;

	for (const environment of metadata.inventory.data?.environments ?? []) {
		for (const application of environment.applications) {
			const build = application.build;
			if (!build?.pipelineRun) continue;
			const candidate: SystemBuildEvidence = {
				environment: environment.name,
				applicationName: application.name,
				component: application.component,
				pipelineRun: build.pipelineRun,
				status: build.status,
				reason: build.reason,
				startedAt: build.startedAt,
				finishedAt: build.finishedAt,
				tag: application.desired.tag,
				commitSha: application.desired.commitSha ?? commitShaFromTag(application.desired.tag),
			};
			if (!latest || timestamp(candidate) > timestamp(latest)) {
				latest = candidate;
			}
		}
	}

	return latest;
}

function summarizePromotion(
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

function findWorkflowBuilderSoak(
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

function timestamp(build: SystemBuildEvidence): number {
	const value = build.finishedAt ?? build.startedAt;
	return value ? new Date(value).getTime() || 0 : 0;
}
