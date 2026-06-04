/**
 * Adapter: turns our deployment-metadata + promotion data into the Kargo-shaped
 * pipeline model (warehouses / subscriptions / stages / freight) that the dagre
 * layout + Svelte node components consume.
 *
 * Two lenses, both produced here (the user-chosen "hybrid"):
 *  - Per-service pipelines  — one warehouse per release-pinned image, fanning
 *    out to its ryzen (direct-main) and dev (Promoter-gated) stages → staging.
 *  - Release-train bundle   — one "release-pins" warehouse (all images + stacks
 *    config) → dev → staging, carrying per-env roll-up counts.
 */
import { ColorMapHex, WarehouseColorMapHex, generateColors } from "./kargo-colors";
import {
	buildServiceMatrix,
	ENVIRONMENTS,
	SUBSYSTEM_ORDER,
	subsystemFor,
	type EnvCell,
	type EnvName,
	type ServiceRow,
} from "./service-matrix";
import { findWorkflowBuilderSoak, summarizePromotion } from "./system-view";
import type {
	FreightArtifact,
	PipelineFreight,
	PipelineModel,
	PipelineStage,
	PipelineWarehouse,
	StageFreightRef,
} from "./pipeline-types";
import type { PromotionStrategiesResponse } from "$lib/server/promoter/types";
import type { DeploymentMetadataResponse, DesiredImageMetadata } from "$lib/types/deployment-metadata";

const GHCR = "ghcr.io/pittampalliorg";
const STACKS_GIT = "github.com/PittampalliOrg/stacks";
export const BUNDLE_WAREHOUSE = "release-pins";
export const RELEASE_TRAIN_SUBSYSTEM = "Release train";

/** Runtime coupling surfaced as informational annotations (not DAG edges). */
const DEPENDED_ON_BY: Record<string, string[]> = {
	"dapr-agent-py-sandbox": ["workflow-builder · AGENT_RUNTIME_DEFAULT_IMAGE"],
	"browser-use-agent-sandbox": ["workflow-builder · AGENT_RUNTIME_BROWSER_USE_DEFAULT_IMAGE"],
	"adk-agent-py-sandbox": ["workflow-builder · AGENT_RUNTIME_ADK_DEFAULT_IMAGE"],
};
const DEPENDS_ON: Record<string, string[]> = {
	"workflow-orchestrator": ["function-router"],
	"function-router": ["fn-system", "code-runtime", "crawl4ai-adapter"],
};

function shortSha(sha: string | null | undefined): string {
	return sha ? sha.slice(0, 7) : "";
}

function imageTag(image: string | null | undefined): string | null {
	if (!image) return null;
	const withoutDigest = image.split("@", 1)[0] ?? image;
	const lastSlash = withoutDigest.lastIndexOf("/");
	const lastColon = withoutDigest.lastIndexOf(":");
	return lastColon > lastSlash ? withoutDigest.slice(lastColon + 1) : null;
}

/** Map an EnvCell onto Kargo's health vocabulary (Healthy/Progressing/Degraded/Unknown). */
function mapHealth(cell: EnvCell | null): string {
	if (!cell) return "Unknown";
	if (cell.healthStatus === "Degraded" || cell.healthStatus === "NotReady") return "Degraded";
	if (cell.source === "inventory" && cell.syncStatus === "OutOfSync") return "Progressing";
	if (cell.driftStatus === "pending_rollout") return "Progressing";
	if (cell.healthStatus === "Healthy" || cell.healthStatus === "Succeeded") return "Healthy";
	if (cell.syncStatus === "Synced") return "Healthy";
	return "Unknown";
}

function makeServiceStage(
	warehouse: string,
	env: EnvName,
	cell: EnvCell,
	requestedFreight: StageFreightRef[],
	opts: { dormant?: boolean; gate?: PipelineStage["gate"] } = {},
): PipelineStage {
	const isLiveOnly = cell.source === "live-only";
	return {
		name: `${warehouse}::${env}`,
		warehouse,
		env,
		requestedFreight,
		health: mapHealth(cell),
		syncStatus: cell.syncStatus,
		promotionPhase: cell.promotionHealth,
		drift: cell.driftStatus,
		desiredTag: isLiveOnly ? null : cell.tag,
		liveTag: isLiveOnly ? cell.tag : imageTag(cell.liveImage),
		commitSha: cell.commitSha,
		source: cell.source,
		updatedAt: cell.updatedAt,
		controlFlow: Boolean(opts.dormant),
		dormant: Boolean(opts.dormant),
		gate: opts.gate ?? null,
	};
}

function buildServicePipelines(
	rows: ServiceRow[],
	pinByName: Map<string, DesiredImageMetadata>,
	soakPhase: string | null,
): { warehouses: PipelineWarehouse[]; stages: PipelineStage[]; freights: PipelineFreight[] } {
	const warehouses: PipelineWarehouse[] = [];
	const stages: PipelineStage[] = [];
	const freights: PipelineFreight[] = [];

	for (const row of rows) {
		const service = row.service;
		const cells = ENVIRONMENTS.map((env) => row.envs[env]).filter((c): c is EnvCell => c != null);
		if (cells.length === 0) continue;

		const laneStages: PipelineStage[] = [];
		const devName = `${service}::dev`;

		// ryzen — direct from stacks main (no Promoter gate)
		const ryzen = row.envs.ryzen;
		if (ryzen) {
			laneStages.push(
				makeServiceStage(service, "ryzen", ryzen, [{ origin: service, sources: { direct: true } }]),
			);
		}
		// dev — direct from the warehouse, gated by the GitOps Promoter soak timer
		const dev = row.envs.dev;
		if (dev) {
			laneStages.push(
				makeServiceStage(service, "dev", dev, [{ origin: service, sources: { direct: true } }], {
					gate: { label: "soak", phase: soakPhase },
				}),
			);
		}
		// staging — downstream of dev (dormant)
		const staging = row.envs.staging;
		if (staging) {
			const source: StageFreightRef = dev
				? { origin: service, sources: { stages: [devName] } }
				: { origin: service, sources: { direct: true } };
			laneStages.push(makeServiceStage(service, "staging", staging, [source], { dormant: true }));
		}

		const hasError = laneStages.some((s) => s.health === "Degraded");
		const reconciling = laneStages.some((s) => s.health === "Progressing");

		warehouses.push({
			name: service,
			kind: "service",
			subsystem: subsystemFor(service),
			subscriptions: [
				{ id: `sub/${service}/image`, type: "image", repoURL: `${GHCR}/${service}` },
			],
			reconciling,
			hasError,
			specialCase: row.specialCase,
			dependedOnBy: DEPENDED_ON_BY[service],
			dependsOn: DEPENDS_ON[service],
		});
		stages.push(...laneStages);

		// One current freight per service (release-pins has no history).
		const pin = pinByName.get(service);
		const tag = pin?.tag ?? cells[0]?.tag ?? null;
		const digest = pin?.digest ?? cells[0]?.digest ?? null;
		const sourceSha = pin?.sourceSha ?? pin?.commitSha ?? cells[0]?.commitSha ?? null;
		freights.push({
			id: `${service}:${tag ?? "unknown"}`,
			warehouse: service,
			alias: sourceSha ? `${service}@${shortSha(sourceSha)}` : (tag ?? service),
			artifacts: [{ kind: "image", repoURL: `${GHCR}/${service}`, tag, digest }],
			createdAt: pin?.updatedAt ?? pin?.commit?.committedAt ?? cells[0]?.updatedAt ?? null,
			inStages: laneStages.filter((s) => !s.dormant).map((s) => s.name),
			current: true,
		});
	}

	return { warehouses, stages, freights };
}

function envRollup(rows: ServiceRow[], env: EnvName) {
	let synced = 0;
	let drift = 0;
	let degraded = 0;
	let total = 0;
	for (const row of rows) {
		const cell = row.envs[env];
		if (!cell) continue;
		total += 1;
		if (cell.healthStatus === "Degraded" || cell.healthStatus === "NotReady") degraded += 1;
		else if (cell.syncStatus === "OutOfSync" || cell.driftStatus === "pending_rollout") drift += 1;
		else synced += 1;
	}
	return { synced, drift, degraded, total };
}

function rollupHealth(r: { synced: number; drift: number; degraded: number; total: number }): string {
	if (r.total === 0) return "Unknown";
	if (r.degraded > 0) return "Degraded";
	if (r.drift > 0) return "Progressing";
	return "Healthy";
}

export function buildPipelineModel(
	metadata: DeploymentMetadataResponse,
	promotions: PromotionStrategiesResponse,
): PipelineModel {
	const rows = buildServiceMatrix({
		inventory: metadata.inventory.data,
		releasePins: metadata.gitops.desiredImages,
		live: metadata.live.deployments,
		currentEnv: metadata.environment.name,
	});

	const pinByName = new Map<string, DesiredImageMetadata>(
		metadata.gitops.desiredImages.map((pin) => [pin.name, pin]),
	);

	const release = summarizePromotion(promotions, "workflow-builder-release");
	const soak = findWorkflowBuilderSoak(promotions);
	const stagingActive = release?.envBranches.includes("env/spokes-staging") ?? false;

	const service = buildServicePipelines(rows, pinByName, soak?.phase ?? null);

	// ── Release-train bundle warehouse + stages ──────────────────────────────
	const devRollup = envRollup(rows, "dev");
	const stagingRollup = envRollup(rows, "staging");
	const stacksSha = metadata.gitops.stacksMain?.sha ?? null;

	const bundleWarehouse: PipelineWarehouse = {
		name: BUNDLE_WAREHOUSE,
		kind: "bundle",
		subsystem: RELEASE_TRAIN_SUBSYSTEM,
		subscriptions: [
			{ id: "sub/bundle/image", type: "image", repoURL: `${GHCR}/*`, name: "all images" },
			{ id: "sub/bundle/git", type: "git", repoURL: STACKS_GIT, name: "config + manifests" },
		],
		reconciling: rollupHealth(devRollup) === "Progressing",
		hasError: rollupHealth(devRollup) === "Degraded",
		specialCase: null,
	};

	const bundleDev: PipelineStage = {
		name: `${BUNDLE_WAREHOUSE}::dev`,
		warehouse: BUNDLE_WAREHOUSE,
		env: "dev",
		requestedFreight: [{ origin: BUNDLE_WAREHOUSE, sources: { direct: true } }],
		health: release?.tone === "failure" ? "Degraded" : rollupHealth(devRollup),
		syncStatus: null,
		promotionPhase: soak?.phase ?? null,
		drift: null,
		desiredTag: null,
		liveTag: null,
		commitSha: release?.activeHydratedSha ?? null,
		source: "inventory",
		updatedAt: release?.updatedAt ?? null,
		controlFlow: false,
		dormant: false,
		rollup: devRollup,
		promoterBranch: release?.activeBranch ?? null,
		promoterHydratedSha: release?.activeHydratedSha ?? null,
		gate: soak ? { label: "soak", phase: soak.phase } : null,
	};

	const bundleStaging: PipelineStage = {
		name: `${BUNDLE_WAREHOUSE}::staging`,
		warehouse: BUNDLE_WAREHOUSE,
		env: "staging",
		requestedFreight: [{ origin: BUNDLE_WAREHOUSE, sources: { stages: [`${BUNDLE_WAREHOUSE}::dev`] } }],
		health: stagingActive ? rollupHealth(stagingRollup) : "Unknown",
		syncStatus: null,
		promotionPhase: null,
		drift: null,
		desiredTag: null,
		liveTag: null,
		commitSha: null,
		source: null,
		updatedAt: null,
		controlFlow: true,
		dormant: !stagingActive,
		rollup: stagingRollup,
		gate: null,
	};

	const bundleArtifacts: FreightArtifact[] = [
		{ kind: "image", repoURL: `${GHCR}/*`, tag: `${pinByName.size} images`, digest: null },
		{ kind: "git", repoURL: STACKS_GIT, sha: stacksSha, message: "release-pins snapshot" },
	];
	const bundleFreight: PipelineFreight = {
		id: `${BUNDLE_WAREHOUSE}@${shortSha(stacksSha) || "main"}`,
		warehouse: BUNDLE_WAREHOUSE,
		alias: `release @ ${shortSha(stacksSha) || metadata.gitops.stacksMain?.shortSha || "main"}`,
		artifacts: bundleArtifacts,
		createdAt: metadata.gitops.stacksMain?.committedAt ?? null,
		inStages: [bundleDev.name, ...(stagingActive ? [bundleStaging.name] : [])],
		current: true,
	};

	const warehouses = [bundleWarehouse, ...service.warehouses];
	const stages = [bundleDev, bundleStaging, ...service.stages];
	const freights = [bundleFreight, ...service.freights];

	// ── Colours: warehouse identity hue; stages inherit their warehouse hue ──
	// Deterministic (sorted names + fixed palette) so SSR and client agree —
	// no localStorage, which would diverge between server and hydration.
	const warehouseColorMap = generateColors(
		warehouses.map((w) => w.name).sort((a, b) => a.localeCompare(b)),
		{},
		WarehouseColorMapHex,
	);
	const stageColorMap: Record<string, string> = {};
	for (const stage of stages) {
		stageColorMap[stage.name] = warehouseColorMap[stage.warehouse] ?? ColorMapHex.gray;
	}
	for (const w of warehouses) {
		w.color = warehouseColorMap[w.name];
	}

	// ── Subsystem grouping (Release train first, then ordered subsystems) ────
	const warehousesBySubsystem: Record<string, PipelineWarehouse[]> = {};
	for (const w of warehouses) {
		(warehousesBySubsystem[w.subsystem] ??= []).push(w);
	}
	const subsystems = [RELEASE_TRAIN_SUBSYSTEM, ...SUBSYSTEM_ORDER].filter(
		(s, i, arr) => arr.indexOf(s) === i && warehousesBySubsystem[s]?.length,
	);

	return {
		warehouses,
		stages,
		freights,
		warehouseColorMap,
		stageColorMap,
		subsystems,
		warehousesBySubsystem,
		generatedAt: metadata.generatedAt,
	};
}
