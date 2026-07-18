/**
 * Fleet-drift extras for the consolidated GitOps page (`getFleetDriftExtras`):
 * repo main HEADs, per-service pin ages, newest-built artifacts (+ in-flight
 * PipelineRuns from the hub inventory), the preview-platform broker-skew datum,
 * and live Deployment observedGeneration convergence.
 *
 * Caching follows the deployment-metadata.ts pattern: cluster reads 15s, raw
 * GitHub fetches 60s (via `github-sources`), pin history 10min (reused from
 * `loadPinHistory`). Every source degrades to nulls — this read never throws.
 */
import { createCachedLoader } from "$lib/server/dev-hub/cache";
import {
	githubSources,
	type BrokerImageSnapshot,
	type ReleasePinsSnapshot,
} from "$lib/server/dev-hub/github-sources";
import {
	getDeploymentMetadata,
	loadPinHistory,
} from "$lib/server/gitops/deployment-metadata";
import {
	getOwnNamespace,
	kubeApiFetch,
	listDeployments,
	type KubeDeployment,
} from "$lib/server/kube/client";
import type {
	FleetDeploymentGeneration,
	FleetDriftExtras,
	FleetNewestBuilt,
	FleetPinAge,
	FleetPreviewPlatformDrift,
	GitCommitMetadata,
	GitOpsInventoryEnvironment,
	ImageVersion,
} from "$lib/types/deployment-metadata";

const CLUSTER_TTL_MS = 15_000;
const PREVIEW_PINS_CONFIGMAP = "workflow-builder-image-pins-preview";

/** Both digests known and different = the broker lags (or leads) the pin. Pure. */
export function computeBrokerSkew(
	brokerImageDigest: string | null,
	releasePinsWorkflowBuilderDigest: string | null,
): boolean {
	return Boolean(
		brokerImageDigest &&
			releasePinsWorkflowBuilderDigest &&
			brokerImageDigest.toLowerCase() !==
				releasePinsWorkflowBuilderDigest.toLowerCase(),
	);
}

/** Per-service pin freshness from the release-pins `updatedAts`. Pure. */
export function buildPinAges(
	pins: ReleasePinsSnapshot,
	now: number,
): FleetPinAge[] {
	return Object.entries(pins.services)
		.map(([service, pin]) => {
			const updatedAt = pin.updatedAt;
			const parsed = updatedAt ? new Date(updatedAt).getTime() : Number.NaN;
			return {
				service,
				updatedAt: updatedAt ?? null,
				ageMs: Number.isFinite(parsed) ? Math.max(0, now - parsed) : null,
			};
		})
		.sort((a, b) => a.service.localeCompare(b.service));
}

/**
 * Newest built artifact per service: the newest pin-history tag (pin commits
 * ARE build history, newest first) + any unfinished PipelineRun the hub
 * inventory reports for the service's applications. Pure.
 */
export function buildNewestBuilt(
	imageHistory: ImageVersion[],
	inventoryEnvironments: GitOpsInventoryEnvironment[],
): FleetNewestBuilt[] {
	const newestByService = new Map<string, ImageVersion>();
	for (const version of imageHistory) {
		// loadPinHistory walks newest→oldest; keep the first entry per service.
		if (!newestByService.has(version.service)) {
			newestByService.set(version.service, version);
		}
	}

	const inFlightByService = new Map<string, string>();
	for (const environment of inventoryEnvironments) {
		for (const application of environment.applications) {
			const build = application.build;
			if (!build?.pipelineRun || build.finishedAt) continue;
			if (!inFlightByService.has(application.component)) {
				inFlightByService.set(application.component, build.pipelineRun);
			}
		}
	}

	const services = new Set([
		...newestByService.keys(),
		...inFlightByService.keys(),
	]);
	return [...services]
		.map((service) => {
			const newest = newestByService.get(service) ?? null;
			return {
				service,
				newestTag: newest?.tag ?? null,
				newestPinCommittedAt: newest?.pinCommittedAt || newest?.committedAt || null,
				inFlightPipelineRun: inFlightByService.get(service) ?? null,
			};
		})
		.sort((a, b) => a.service.localeCompare(b.service));
}

/** Deployment generation convergence rows from live Deployments. Pure. */
export function buildDeploymentGenerations(
	deployments: KubeDeployment[],
): FleetDeploymentGeneration[] {
	return deployments
		.map((deployment) => {
			const generation = deployment.metadata?.generation ?? null;
			const observedGeneration = deployment.status?.observedGeneration ?? null;
			return {
				name: deployment.metadata?.name ?? "unknown",
				generation,
				observedGeneration,
				converged:
					generation != null && observedGeneration != null
						? observedGeneration >= generation
						: null,
			};
		})
		.sort((a, b) => a.name.localeCompare(b.name));
}

export type FleetDriftBuildInput = {
	pins: ReleasePinsSnapshot;
	imageHistory: ImageVersion[];
	inventoryEnvironments: GitOpsInventoryEnvironment[];
	workflowBuilderMainHead: GitCommitMetadata | null;
	stacksMainHead: GitCommitMetadata | null;
	broker: BrokerImageSnapshot;
	previewPinRevision: string | null;
	deployments: KubeDeployment[];
	now?: number;
};

/** Assemble the extras DTO from already-fetched sources. Pure; unit-tested. */
export function buildFleetDriftExtras(input: FleetDriftBuildInput): FleetDriftExtras {
	const now = input.now ?? Date.now();
	const releasePinsWorkflowBuilderDigest =
		input.pins.services["workflow-builder"]?.digest ?? null;
	const previewPlatform: FleetPreviewPlatformDrift = {
		pinRevision: input.previewPinRevision,
		brokerImageDigest: input.broker.digest,
		releasePinsWorkflowBuilderDigest,
		skew: computeBrokerSkew(input.broker.digest, releasePinsWorkflowBuilderDigest),
	};
	return {
		generatedAt: new Date(now).toISOString(),
		workflowBuilderMainHead: input.workflowBuilderMainHead,
		stacksMainHead: input.stacksMainHead,
		pinAges: buildPinAges(input.pins, now),
		newestBuilt: buildNewestBuilt(input.imageHistory, input.inventoryEnvironments),
		previewPlatform,
		liveDeployments: buildDeploymentGenerations(input.deployments),
	};
}

/** Hub inventory environments via the shared inventory feed (15s cached upstream). */
async function loadInventoryEnvironments(): Promise<GitOpsInventoryEnvironment[]> {
	try {
		const metadata = await getDeploymentMetadata();
		return metadata.inventory.data?.environments ?? [];
	} catch {
		return [];
	}
}

async function readPreviewPinsRevisionUncached(): Promise<string | null> {
	const namespace = await getOwnNamespace();
	const response = await kubeApiFetch(
		`/api/v1/namespaces/${encodeURIComponent(namespace)}/configmaps/${PREVIEW_PINS_CONFIGMAP}`,
	);
	if (!response.ok) {
		throw new Error(`configmap ${PREVIEW_PINS_CONFIGMAP}: ${response.status}`);
	}
	const body = (await response.json()) as {
		data?: Record<string, string>;
	};
	return body.data?.["pins-hash"]?.trim() || null;
}

const previewPinsRevision = createCachedLoader<string | null>({
	ttlMs: CLUSTER_TTL_MS,
	load: readPreviewPinsRevisionUncached,
	fallback: (_cause, stale) => stale ?? null,
});

const ownDeployments = createCachedLoader<KubeDeployment[]>({
	ttlMs: CLUSTER_TTL_MS,
	load: async () => listDeployments(await getOwnNamespace()),
	fallback: (_cause, stale) => stale ?? [],
});

const extras = createCachedLoader<FleetDriftExtras>({
	ttlMs: CLUSTER_TTL_MS,
	load: async () => {
		const [
			pins,
			pinHistory,
			inventoryEnvironments,
			workflowBuilderMainHead,
			stacksMainHead,
			broker,
			previewPinRevision,
			deployments,
		] = await Promise.all([
			githubSources.getReleasePins(),
			loadPinHistory().catch(() => ({ imageHistory: [], error: "unavailable" })),
			loadInventoryEnvironments(),
			githubSources.getMainHead("workflow-builder"),
			githubSources.getMainHead("stacks"),
			githubSources.getBrokerImage(),
			previewPinsRevision.get(),
			ownDeployments.get(),
		]);
		return buildFleetDriftExtras({
			pins,
			imageHistory: pinHistory.imageHistory,
			inventoryEnvironments,
			workflowBuilderMainHead,
			stacksMainHead,
			broker,
			previewPinRevision,
			deployments,
		});
	},
	fallback: (_cause, stale) =>
		stale ?? {
			generatedAt: new Date().toISOString(),
			workflowBuilderMainHead: null,
			stacksMainHead: null,
			pinAges: [],
			newestBuilt: [],
			previewPlatform: {
				pinRevision: null,
				brokerImageDigest: null,
				releasePinsWorkflowBuilderDigest: null,
				skew: false,
			},
			liveDeployments: [],
		},
});

export function invalidateFleetDriftCaches(): void {
	previewPinsRevision.invalidate();
	ownDeployments.invalidate();
	extras.invalidate();
}

/** The remote query's entry point. Cached 15s; degrades, never throws. */
export function loadFleetDriftExtras(): Promise<FleetDriftExtras> {
	return extras.get();
}
