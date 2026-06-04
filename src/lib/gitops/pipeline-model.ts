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
 *
 * Freight stream (Kargo-style accumulation): each warehouse carries a list of
 * freights built from `gitops.imageHistory` (newest→oldest, one per historical
 * pin), NOT a single current pin — so a new pin ADDS a freight rather than
 * replacing the previous one. The release-pins bundle's freight stream is one
 * freight per pin-commit snapshot.
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
import {
	findWorkflowBuilderSoak,
	summarizeEnvPromotions,
	summarizePromotion,
	type EnvPromotionState,
} from "./system-view";
import type {
	FreightArtifact,
	PipelineFreight,
	PipelineModel,
	PipelineStage,
	PipelineWarehouse,
	StageFreightRef,
	StagePromotion,
} from "./pipeline-types";
import type { PromotionStrategiesResponse } from "$lib/server/promoter/types";
import type {
	DeploymentMetadataResponse,
	DesiredImageMetadata,
	ImageVersion,
} from "$lib/types/deployment-metadata";

const GHCR = "ghcr.io/pittampalliorg";
const STACKS_GIT = "github.com/PittampalliOrg/stacks";
export const BUNDLE_WAREHOUSE = "release-pins";
export const RELEASE_TRAIN_SUBSYSTEM = "Release train";

/**
 * The Promoter env branch each environment maps to. Only `dev` is gated by the
 * GitOps Promoter today; ryzen is direct-main (no env branch) and staging is
 * dormant.
 */
export const ENV_PROMOTER_BRANCH: Partial<Record<EnvName, string>> = {
	dev: "env/spokes-dev",
	staging: "env/spokes-staging",
};

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

/**
 * A pin-only / live-only cell carries a desired-or-running tag but no reconciled
 * inventory evidence (sync/health). Render those as "awaiting reconcile" — a
 * distinct state from a healthy synced inventory cell. An `inventory` cell that
 * is genuinely Synced+Healthy is NOT awaiting reconcile.
 */
function isAwaitingReconcile(cell: EnvCell): boolean {
	if (cell.source === "pin-only") return true;
	if (cell.source === "live-only") {
		// live-only with a confirmed desiredMatches=true rollout reads as settled.
		return cell.driftStatus === "pending_rollout";
	}
	// inventory cell: awaiting reconcile if not yet synced/healthy.
	const healthy =
		cell.syncStatus === "Synced" &&
		(cell.healthStatus === "Healthy" || cell.healthStatus === "Succeeded");
	return !healthy && (cell.syncStatus === null || cell.driftStatus === "pending_rollout");
}

function makeServiceStage(
	warehouse: string,
	env: EnvName,
	cell: EnvCell,
	requestedFreight: StageFreightRef[],
	opts: {
		dormant?: boolean;
		deliveryMode?: PipelineStage["deliveryMode"];
		gate?: PipelineStage["gate"];
		promotion?: StagePromotion | null;
	} = {},
): PipelineStage {
	const isLiveOnly = cell.source === "live-only";
	const deliveryMode = opts.deliveryMode ?? (opts.dormant ? "dormant" : "promoter");
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
		deliveryMode,
		awaitingReconcile: isAwaitingReconcile(cell),
		gate: opts.gate ?? null,
		promotion: opts.promotion ?? null,
	};
}

/**
 * Build a per-env `StagePromotion` from the Promoter env state. Returns null
 * when there's no Promoter state for this env's branch (defensive — caller only
 * passes this for the dev/promoter stage).
 */
function stagePromotionFor(env: EnvPromotionState | undefined): StagePromotion | null {
	if (!env) return null;
	return {
		inFlight: env.inFlight,
		proposedTag: env.proposedHydratedSha ?? env.proposedDrySha ?? null,
		activeTag: env.activeHydratedSha ?? env.activeDrySha ?? null,
		gates: env.gates,
		soak: env.soak,
		pullRequest: env.pullRequest,
		stalledOn: env.stalledOn,
	};
}

/**
 * Build the per-warehouse freight stream from `imageHistory` (newest→oldest),
 * one freight per historical version of this service. Falls back to the single
 * current pin when history has no entries for the service.
 *
 * `current` is set on the freight whose tag matches the live/desired tag.
 * `inStages` is which env stages currently hold each version (compared to the
 * per-env desired/live tags from the service-matrix).
 */
function serviceFreightStream(
	service: string,
	historyByService: Map<string, ImageVersion[]>,
	pin: DesiredImageMetadata | undefined,
	cells: EnvCell[],
	laneStages: PipelineStage[],
	desiredTag: string | null,
): PipelineFreight[] {
	const tagsHeldByStage = (tag: string | null): string[] => {
		if (!tag) return [];
		return laneStages
			.filter((stage) => !stage.dormant)
			.filter((stage) => {
				// A version is "in" a stage when that stage's desired (or, for
				// live-only/ryzen, its live) tag equals the version's tag.
				const stageTag = stage.desiredTag ?? stage.liveTag;
				return stageTag != null && stageTag === tag;
			})
			.map((stage) => stage.name);
	};

	const history = historyByService.get(service) ?? [];
	if (history.length > 0) {
		return history.map((version, index): PipelineFreight => {
			const sourceSha = version.sourceSha ?? null;
			return {
				id: `${service}:${version.tag}:${version.pinCommit}`,
				warehouse: service,
				alias: sourceSha ? `${service}@${shortSha(sourceSha)}` : version.tag,
				artifacts: [
					{ kind: "image", repoURL: `${GHCR}/${service}`, tag: version.tag, digest: version.digest },
				],
				createdAt: version.committedAt ?? (version.pinCommittedAt || null),
				inStages: tagsHeldByStage(version.tag),
				// The freight whose tag matches the live/desired tag is "current".
				// Fall back to the newest (index 0) when no desired tag is known.
				current: desiredTag != null ? version.tag === desiredTag : index === 0,
			};
		});
	}

	// ── Fallback: no history for this service → one current freight from the pin.
	const tag = pin?.tag ?? cells[0]?.tag ?? null;
	const digest = pin?.digest ?? cells[0]?.digest ?? null;
	const sourceSha = pin?.sourceSha ?? pin?.commitSha ?? cells[0]?.commitSha ?? null;
	return [
		{
			id: `${service}:${tag ?? "unknown"}`,
			warehouse: service,
			alias: sourceSha ? `${service}@${shortSha(sourceSha)}` : (tag ?? service),
			artifacts: [{ kind: "image", repoURL: `${GHCR}/${service}`, tag, digest }],
			createdAt: pin?.updatedAt ?? pin?.commit?.committedAt ?? cells[0]?.updatedAt ?? null,
			inStages: tagsHeldByStage(tag),
			current: true,
		},
	];
}

function buildServicePipelines(
	rows: ServiceRow[],
	pinByName: Map<string, DesiredImageMetadata>,
	historyByService: Map<string, ImageVersion[]>,
	soakPhase: string | null,
	devPromotion: EnvPromotionState | undefined,
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

		// ryzen — DIRECT-MAIN: reads the bare workload kustomization on stacks
		// main. No Promoter env branch → no proposed-vs-active promotion tone; we
		// surface its pin/source commit instead (no fabricated promoter state).
		const ryzen = row.envs.ryzen;
		if (ryzen) {
			laneStages.push(
				makeServiceStage(service, "ryzen", ryzen, [{ origin: service, sources: { direct: true } }], {
					deliveryMode: "direct-main",
					promotion: null,
				}),
			);
		}
		// dev — gated by the GitOps Promoter (env/spokes-dev) soak timer. Carries
		// the per-env promotion object (proposed-vs-active, gates, soak, PR).
		const dev = row.envs.dev;
		if (dev) {
			laneStages.push(
				makeServiceStage(service, "dev", dev, [{ origin: service, sources: { direct: true } }], {
					deliveryMode: "promoter",
					gate: { label: "soak", phase: soakPhase },
					promotion: stagePromotionFor(devPromotion),
				}),
			);
		}
		// staging — downstream of dev (dormant)
		const staging = row.envs.staging;
		if (staging) {
			const source: StageFreightRef = dev
				? { origin: service, sources: { stages: [devName] } }
				: { origin: service, sources: { direct: true } };
			laneStages.push(
				makeServiceStage(service, "staging", staging, [source], {
					dormant: true,
					deliveryMode: "dormant",
					promotion: null,
				}),
			);
		}

		const hasError = laneStages.some((s) => s.health === "Degraded");
		const reconciling =
			laneStages.some((s) => s.health === "Progressing") ||
			laneStages.some((s) => s.deliveryMode === "promoter" && s.promotion?.inFlight === true);

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

		// The live/desired tag for the warehouse: prefer the dev desired tag (the
		// promoter target), then ryzen's tag, then the pin.
		const desiredTag =
			row.envs.dev?.tag ?? row.envs.ryzen?.tag ?? pinByName.get(service)?.tag ?? cells[0]?.tag ?? null;

		freights.push(
			...serviceFreightStream(
				service,
				historyByService,
				pinByName.get(service),
				cells,
				laneStages,
				desiredTag,
			),
		);
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

/** Group the flat `imageHistory` array into per-service streams (preserving order). */
function groupHistoryByService(history: ImageVersion[]): Map<string, ImageVersion[]> {
	const map = new Map<string, ImageVersion[]>();
	for (const version of history) {
		const list = map.get(version.service);
		if (list) list.push(version);
		else map.set(version.service, [version]);
	}
	return map;
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
	const historyByService = groupHistoryByService(metadata.gitops.imageHistory ?? []);

	const release = summarizePromotion(promotions, "workflow-builder-release");
	const envPromotions = summarizeEnvPromotions(promotions, "workflow-builder-release");
	const devPromotion = envPromotions.get(ENV_PROMOTER_BRANCH.dev ?? "env/spokes-dev");
	const soak = findWorkflowBuilderSoak(promotions);
	const stagingActive = release?.envBranches.includes("env/spokes-staging") ?? false;

	const service = buildServicePipelines(
		rows,
		pinByName,
		historyByService,
		soak?.phase ?? null,
		devPromotion,
	);

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
		reconciling: rollupHealth(devRollup) === "Progressing" || (devPromotion?.inFlight ?? false),
		hasError: rollupHealth(devRollup) === "Degraded",
		specialCase: null,
	};

	const bundleDevPromotion = stagePromotionFor(devPromotion);
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
		deliveryMode: "promoter",
		awaitingReconcile: bundleDevPromotion?.inFlight ?? false,
		rollup: devRollup,
		promoterBranch: release?.activeBranch ?? null,
		promoterHydratedSha: release?.activeHydratedSha ?? null,
		gate: soak ? { label: "soak", phase: soak.phase } : null,
		promotion: bundleDevPromotion,
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
		deliveryMode: "dormant",
		awaitingReconcile: false,
		rollup: stagingRollup,
		gate: null,
		promotion: null,
	};

	const bundleFreights = buildBundleFreightStream(metadata, pinByName.size, stagingActive, [
		bundleDev.name,
		bundleStaging.name,
	]);

	const warehouses = [bundleWarehouse, ...service.warehouses];
	const stages = [bundleDev, bundleStaging, ...service.stages];
	const freights = [...bundleFreights, ...service.freights];

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

/**
 * The release-pins BUNDLE warehouse freight stream = one freight per pin-commit
 * snapshot. We derive distinct pin commits from `imageHistory` (each pin commit
 * is a release-pins snapshot) and emit one bundle freight per commit, newest→
 * oldest. Falls back to a single current snapshot keyed on stacks-main when no
 * history is available.
 */
function buildBundleFreightStream(
	metadata: DeploymentMetadataResponse,
	imageCount: number,
	stagingActive: boolean,
	bundleStageNames: [devName: string, stagingName: string],
): PipelineFreight[] {
	const [devName, stagingName] = bundleStageNames;
	const inStages = [devName, ...(stagingActive ? [stagingName] : [])];
	const history = metadata.gitops.imageHistory ?? [];
	const stacksSha = metadata.gitops.stacksMain?.sha ?? null;

	// Distinct pin commits (preserving newest→oldest order from the flat history).
	const seen = new Set<string>();
	const pinCommits: ImageVersion[] = [];
	for (const version of history) {
		if (seen.has(version.pinCommit)) continue;
		seen.add(version.pinCommit);
		pinCommits.push(version);
	}

	if (pinCommits.length > 0) {
		return pinCommits.map((commit, index): PipelineFreight => {
			const createdAt = commit.pinCommittedAt || commit.committedAt || null;
			return {
				id: `${BUNDLE_WAREHOUSE}@${shortSha(commit.pinCommit)}`,
				warehouse: BUNDLE_WAREHOUSE,
				alias: `release @ ${shortSha(commit.pinCommit) || "main"}`,
				artifacts: [
					{ kind: "image", repoURL: `${GHCR}/*`, tag: `${imageCount} images`, digest: null },
					{
						kind: "git",
						repoURL: STACKS_GIT,
						sha: commit.pinCommit,
						message: commit.message ?? "release-pins snapshot",
					},
				],
				createdAt,
				// The newest pin commit is the one the bundle stages currently hold.
				inStages: index === 0 ? inStages : [],
				current: index === 0,
			};
		});
	}

	// ── Fallback: no history → single current snapshot keyed on stacks main.
	const artifacts: FreightArtifact[] = [
		{ kind: "image", repoURL: `${GHCR}/*`, tag: `${imageCount} images`, digest: null },
		{ kind: "git", repoURL: STACKS_GIT, sha: stacksSha, message: "release-pins snapshot" },
	];
	return [
		{
			id: `${BUNDLE_WAREHOUSE}@${shortSha(stacksSha) || "main"}`,
			warehouse: BUNDLE_WAREHOUSE,
			alias: `release @ ${shortSha(stacksSha) || metadata.gitops.stacksMain?.shortSha || "main"}`,
			artifacts,
			createdAt: metadata.gitops.stacksMain?.committedAt ?? null,
			inStages,
			current: true,
		},
	];
}
