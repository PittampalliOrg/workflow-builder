import { isPromotionPassing } from "$lib/gitops/gates";
import type {
	DesiredImageMetadata,
	GitOpsDeploymentInventory,
	GitOpsInventoryApplication,
	LiveDeploymentMetadata,
} from "$lib/types/deployment-metadata";
import { commitShaFromTag } from "$lib/utils/gitops-display";

export type EnvName = "ryzen" | "dev" | "staging";

export const ENVIRONMENTS: readonly EnvName[] = ["dev", "staging", "ryzen"] as const;

/**
 * Ordered list of every workflow-builder system service that the admin GitOps
 * view should render. Order matches how operators typically think about the
 * fleet: primary service first, then the supporting platform services, then
 * per-language runtimes, then sandboxes, then the single-source controller.
 */
export const WB_SERVICES = [
	"workflow-builder",
	"workflow-mcp-server",
	"mcp-gateway",
	"function-router",
	"workflow-orchestrator",
	"code-parser",
	"code-runtime",
	"workspace-runtime",
	"openshell-agent-runtime",
	"openshell-sandbox",
	"openshell-sandbox-xlsx",
	"dapr-agent-py-sandbox",
	"adk-agent-py-sandbox",
	"claude-agent-py-sandbox",
	"browser-use-agent-sandbox",
] as const;

// Widened to `string` so the matrix can render every release-pinned image, not
// just the curated set above. `WB_SERVICES` still seeds the display ordering.
export type ServiceName = string;

/**
 * Subsystem grouping for the pipeline view's warehouse filter / rail. Drives how
 * the ~25 services are organized into collapsible groups (Kargo's "warehouse
 * filter for better grouping"). Unknown services fall back to "Other".
 */
export const SUBSYSTEMS: Record<string, string> = {
	// Core platform
	"workflow-builder": "Core platform",
	"workflow-orchestrator": "Core platform",
	"function-router": "Core platform",
	"mcp-gateway": "Core platform",
	"workflow-mcp-server": "Core platform",
	"piece-mcp-server": "Core platform",
	// Function execution
	"fn-system": "Function execution",
	"code-parser": "Function execution",
	"code-runtime": "Function execution",
	"crawl4ai-adapter": "Function execution",
	// Agent runtimes
	"dapr-agent-py-sandbox": "Agent runtimes",
	"dapr-agent-py-testing-sandbox": "Agent runtimes",
	"adk-agent-py-sandbox": "Agent runtimes",
	"claude-agent-py-sandbox": "Agent runtimes",
	"browser-use-agent-sandbox": "Agent runtimes",
	"openshell-agent-runtime": "Agent runtimes",
	"openshell-sandbox": "Agent runtimes",
	"openshell-sandbox-xlsx": "Agent runtimes",
	"workspace-runtime": "Agent runtimes",
	"sandbox-execution-api": "Agent runtimes",
	"browserstation": "Agent runtimes",
	"chrome-sandbox": "Agent runtimes",
	// Eval & SWE-bench
	"swebench-coordinator": "Eval & SWE-bench",
	"swebench-evaluator": "Eval & SWE-bench",
	"evaluation-coordinator": "Eval & SWE-bench",
};

export const SUBSYSTEM_ORDER: readonly string[] = [
	"Core platform",
	"Function execution",
	"Agent runtimes",
	"Eval & SWE-bench",
	"Other",
] as const;

export function subsystemFor(service: string): string {
	return SUBSYSTEMS[service] ?? "Other";
}

/**
 * Tool/base images that ride in release-pins but are not deployable services of
 * ours — excluded from the per-service pipeline list so they don't show up as
 * spurious "pipelines".
 */
const NON_SERVICE_IMAGES = new Set<string>([
	"kubectl",
	"postgres",
	"redis",
	"busybox",
	"alpine",
]);

/**
 * The full ordered list of services to render: curated `WB_SERVICES` first (for
 * a stable, operator-familiar ordering), then any other release-pinned image not
 * already covered, alphabetically — minus tool/base images.
 */
export function computeServiceList(releasePins: { name: string }[]): string[] {
	const seen = new Set<string>();
	const out: string[] = [];
	for (const name of WB_SERVICES) {
		if (NON_SERVICE_IMAGES.has(name)) continue;
		if (!seen.has(name)) {
			seen.add(name);
			out.push(name);
		}
	}
	const extras = releasePins
		.map((pin) => pin.name)
		.filter((name) => name && !seen.has(name) && !NON_SERVICE_IMAGES.has(name))
		.sort((a, b) => a.localeCompare(b));
	for (const name of extras) {
		if (!seen.has(name)) {
			seen.add(name);
			out.push(name);
		}
	}
	return out;
}

/**
 * Services whose image tag is set in release-pins (and for dev/staging, in the
 * hub inventory) but which do not run as a long-lived Deployment on the spoke
 * — they're consumed by per-session/per-agent SandboxTemplate references and
 * launched on demand by the upstream agent-sandbox controller. We still want
 * them in the matrix so operators can see what tag will be launched, but we
 * render them with a "runtime-launched" variant instead of showing sync/
 * health.
 */
const SANDBOX_ONLY = new Set<string>([
	"openshell-sandbox",
	"openshell-sandbox-xlsx",
	"dapr-agent-py-sandbox",
	"adk-agent-py-sandbox",
	"claude-agent-py-sandbox",
	"browser-use-agent-sandbox",
]);

export type SpecialCase =
	| "sandbox-only"
	| "ryzen-missing-pin"
	| "ryzen-only"
	| null;

export type EnvCell = {
	source: "inventory" | "pin-only" | "live-only";
	tag: string | null;
	digest: string | null;
	commitSha: string | null;
	desiredImage: string | null;
	liveImage: string | null;
	syncStatus: string | null;
	healthStatus: string | null;
	driftStatus: "in_sync" | "pending_rollout" | "unknown" | string | null;
	promotionHealth: string | null;
	hydratedSha: string | null;
	buildStatus: string | null;
	buildReason: string | null;
	buildPipelineRun: string | null;
	buildStartedAt: string | null;
	buildFinishedAt: string | null;
	updatedAt: string | null;
	applicationName: string | null;
	ready: boolean | null;
};

export type ServiceRow = {
	service: ServiceName;
	specialCase: SpecialCase;
	envs: Record<EnvName, EnvCell | null>;
};

export type BuildServiceMatrixInput = {
	inventory: GitOpsDeploymentInventory | null;
	releasePins: DesiredImageMetadata[];
	live?: LiveDeploymentMetadata[];
	currentEnv?: string | null;
};

export function specialCaseFor(service: ServiceName): SpecialCase {
	if (SANDBOX_ONLY.has(service)) return "sandbox-only";
	if (service === "mcp-gateway") return "ryzen-missing-pin";
	if (service === "openshell-agent-runtime") return "ryzen-only";
	return null;
}

export function buildServiceMatrix(input: BuildServiceMatrixInput): ServiceRow[] {
	const { inventory, releasePins, live, currentEnv } = input;

	const pinByName = new Map<string, DesiredImageMetadata>(
		releasePins.map((pin) => [pin.name, pin]),
	);
	const appByKey = new Map<string, GitOpsInventoryApplication>();
	for (const environment of inventory?.environments ?? []) {
		for (const app of environment.applications) {
			appByKey.set(`${environment.name}:${app.component}`, app);
			// Also index by application name suffix to tolerate umbrella app naming.
			appByKey.set(`${environment.name}:name:${app.name}`, app);
		}
	}

	const liveByContainer = new Map<string, LiveDeploymentMetadata>();
	for (const deployment of live ?? []) {
		for (const container of deployment.containers) {
			if (container.name) liveByContainer.set(container.name, deployment);
		}
	}

	const services = computeServiceList(releasePins);
	return services.map((service) => {
		const specialCase = specialCaseFor(service);
		const row: ServiceRow = {
			service,
			specialCase,
			envs: { ryzen: null, dev: null, staging: null },
		};

		for (const env of ENVIRONMENTS) {
			row.envs[env] = computeCell(
				service,
				env,
				specialCase,
				appByKey.get(`${env}:${service}`) ?? null,
				pinByName.get(service) ?? null,
				env === currentEnv ? liveByContainer.get(service) ?? null : null,
			);
		}

		return row;
	});
}

function computeCell(
	service: ServiceName,
	env: EnvName,
	specialCase: SpecialCase,
	app: GitOpsInventoryApplication | null,
	pin: DesiredImageMetadata | null,
	liveDeployment: LiveDeploymentMetadata | null,
): EnvCell | null {
	if (app) {
		return fromInventory(app, service);
	}

	switch (specialCase) {
		case "ryzen-only":
			return env === "ryzen" ? liveFallback(service, liveDeployment) : null;
		case "ryzen-missing-pin":
			// mcp-gateway has no ryzen kustomization images block — no pinned tag on
			// ryzen. If we happen to have live metadata for the current env, use it
			// so the operator still sees the running tag.
			if (env === "ryzen") return liveFallback(service, liveDeployment);
			return pin ? fromPinOnly(pin) : null;
		case "sandbox-only":
			// Sandbox images have no Deployment on any spoke. Promoted via
			// release-pins to ghcr.io; surface the pinned tag on dev/staging only.
			return env === "ryzen" ? null : pin ? fromPinOnly(pin) : null;
		default:
			// For a regular service that the hub inventory has no entry for on this
			// env, two fallbacks are useful:
			//   - current-env live: the pod we're running in knows its own ryzen
			//     deployments, which is valuable because the hub inventory today
			//     only covers dev+staging.
			//   - pin-only on non-ryzen: the release-pins file is the
			//     dev/staging desired tag even before the hub reconciles.
			const live = liveFallback(service, liveDeployment);
			if (live) return live;
			if (env !== "ryzen" && pin) return fromPinOnly(pin);
			return null;
	}
}

function fromInventory(
	app: GitOpsInventoryApplication,
	service: ServiceName,
): EnvCell {
	const liveImage = pickLiveImageForService(app.live.images, service);
	const provenanceCreated =
		app.provenance?.["org.opencontainers.image.created"] ?? null;
	const updatedAt =
		maxIso(app.build?.finishedAt, provenanceCreated) ??
		app.build?.startedAt ??
		null;

	return {
		source: "inventory",
		tag: app.desired.tag,
		digest: app.desired.digest,
		commitSha: app.desired.commitSha ?? commitShaFromTag(app.desired.tag),
		desiredImage: app.desired.image,
		liveImage,
		syncStatus: app.live.syncStatus,
		healthStatus: app.live.healthStatus,
		driftStatus: app.drift?.status ?? null,
		promotionHealth: app.promotion?.healthPhase ?? null,
		hydratedSha: app.promotion?.hydratedSha ?? null,
		buildStatus: app.build?.status ?? null,
		buildReason: app.build?.reason ?? null,
		buildPipelineRun: app.build?.pipelineRun ?? null,
		buildStartedAt: app.build?.startedAt ?? null,
		buildFinishedAt: app.build?.finishedAt ?? null,
		updatedAt,
		applicationName: app.name,
		ready: null,
	};
}

function fromPinOnly(pin: DesiredImageMetadata): EnvCell {
	return {
		source: "pin-only",
		tag: pin.tag,
		digest: null,
		commitSha: pin.commitSha ?? commitShaFromTag(pin.tag),
		desiredImage: null,
		liveImage: null,
		syncStatus: null,
		healthStatus: null,
		driftStatus: null,
		promotionHealth: null,
		hydratedSha: null,
		buildStatus: null,
		buildReason: null,
		buildPipelineRun: null,
		buildStartedAt: null,
		buildFinishedAt: null,
		updatedAt: pin.commit?.committedAt ?? null,
		applicationName: null,
		ready: null,
	};
}

function liveFallback(
	service: ServiceName,
	deployment: LiveDeploymentMetadata | null,
): EnvCell | null {
	if (!deployment) return null;
	const container =
		deployment.containers.find((candidate) => candidate.name === service) ??
		deployment.containers.find((candidate) => candidate.containerName === service) ??
		deployment.containers[0];
	if (!container) return null;

	return {
		source: "live-only",
		tag: container.tag ?? null,
		digest: container.digest ?? null,
		commitSha: container.commitSha,
		desiredImage: null,
		liveImage: container.image,
		syncStatus: null,
		healthStatus: container.ready === false ? "NotReady" : container.ready === true ? "Healthy" : null,
		driftStatus:
			container.desiredMatches === true
				? "in_sync"
				: container.desiredMatches === false
					? "pending_rollout"
					: null,
		promotionHealth: null,
		hydratedSha: null,
		buildStatus: null,
		buildReason: null,
		buildPipelineRun: null,
		buildStartedAt: null,
		buildFinishedAt: null,
		updatedAt: null,
		applicationName: deployment.name,
		ready: container.ready,
	};
}

function pickLiveImageForService(
	images: string[] | null | undefined,
	service: ServiceName,
): string | null {
	if (!images || images.length === 0) return null;
	// Prefer an image whose repo tail matches the service (e.g. .../workflow-builder:tag).
	const match = images.find((image) => imageName(image) === service);
	return match ?? images[0] ?? null;
}

function imageName(image: string): string | null {
	const withoutDigest = image.split("@", 1)[0] ?? image;
	const lastSlash = withoutDigest.lastIndexOf("/");
	const lastColon = withoutDigest.lastIndexOf(":");
	const hasTag = lastColon > lastSlash;
	const repo = hasTag ? withoutDigest.slice(0, lastColon) : withoutDigest;
	const tail = repo.split("/").pop();
	return tail ?? null;
}

function maxIso(
	a: string | null | undefined,
	b: string | null | undefined,
): string | null {
	if (a && b) return new Date(a).getTime() >= new Date(b).getTime() ? a : b;
	return a ?? b ?? null;
}

/**
 * Summary counts used by AttentionBanner so we can decide whether to surface
 * anything at all. Non-zero drift / failure means "something is stuck"; if all
 * these are zero and there are no inventory errors, the banner stays silent.
 */
export type MatrixSummary = {
	totalServices: number;
	servicesWithAnyEnv: number;
	driftCount: number;
	failedBuilds: number;
	degradedApps: number;
	pendingPromotions: number;
};

export function summarizeMatrix(rows: ServiceRow[]): MatrixSummary {
	let servicesWithAnyEnv = 0;
	let driftCount = 0;
	let failedBuilds = 0;
	let degradedApps = 0;
	let pendingPromotions = 0;

	for (const row of rows) {
		const cells = ENVIRONMENTS.map((env) => row.envs[env]).filter(
			(cell): cell is EnvCell => cell !== null,
		);
		if (cells.length > 0) servicesWithAnyEnv += 1;

		for (const cell of cells) {
			// Only inventory cells contribute to drift counts — live-only fallback
			// cells (ryzen from K8s) compare gitea-ryzen tags vs ghcr.io pins and
			// would always appear to "drift".
			if (cell.source === "inventory") {
				const isHealthy =
					cell.syncStatus === "Synced" &&
					(cell.healthStatus === "Healthy" || cell.healthStatus === "Succeeded");
				if (cell.syncStatus === "OutOfSync") driftCount += 1;
				else if (cell.driftStatus === "pending_rollout" && !isHealthy) driftCount += 1;
			}
			if (cell.healthStatus === "Degraded") degradedApps += 1;
			if (
				cell.buildStatus === "False" ||
				cell.buildReason === "Failed" ||
				cell.buildReason === "Failure"
			) {
				failedBuilds += 1;
			}
			if (cell.promotionHealth && !isPromotionPassing(cell.promotionHealth)) {
				pendingPromotions += 1;
			}
		}
	}

	return {
		totalServices: rows.length,
		servicesWithAnyEnv,
		driftCount,
		failedBuilds,
		degradedApps,
		pendingPromotions,
	};
}

export type RowOverallStatus = "healthy" | "drift" | "degraded" | "empty" | "unknown";

export type RowSummary = {
	overall: RowOverallStatus;
	updatedAt: string | null;
	hasPopulatedCell: boolean;
};

/**
 * Single-row summary that drives the master-table status dot. Worst-state wins:
 * a degraded cell (or failed build) beats a drifted one, which beats healthy.
 * `updatedAt` is the most-recent timestamp across the row's populated cells.
 */
export function summarizeRow(row: ServiceRow): RowSummary {
	const cells = ENVIRONMENTS.map((env) => row.envs[env]).filter(
		(cell): cell is EnvCell => cell !== null,
	);
	if (cells.length === 0) {
		return { overall: "empty", updatedAt: null, hasPopulatedCell: false };
	}

	let hasDegraded = false;
	let hasDrift = false;
	let hasUnknown = false;
	let anyHealthy = false;
	let updatedAt: string | null = null;

	for (const cell of cells) {
		if (cell.updatedAt) {
			if (!updatedAt || new Date(cell.updatedAt).getTime() > new Date(updatedAt).getTime()) {
				updatedAt = cell.updatedAt;
			}
		}
		if (
			cell.healthStatus === "Degraded" ||
			cell.buildStatus === "False" ||
			cell.buildReason === "Failed" ||
			cell.buildReason === "Failure"
		) {
			hasDegraded = true;
			continue;
		}
		const isInventoryHealthy =
			cell.source === "inventory" &&
			cell.syncStatus === "Synced" &&
			(cell.healthStatus === "Healthy" || cell.healthStatus === "Succeeded");
		// Drift only matters when it comes from an inventory cell. A live-only
		// fallback (ryzen from local K8s) reports drift by comparing its
		// gitea-ryzen tag against the dev/staging release-pin — different
		// registries entirely, so the signal is meaningless. We also trust
		// Synced+Healthy over the inventory's own `drift.status` heuristic.
		if (cell.source === "inventory") {
			if (
				cell.syncStatus === "OutOfSync" ||
				(cell.driftStatus === "pending_rollout" && !isInventoryHealthy)
			) {
				hasDrift = true;
				continue;
			}
		}
		if (isInventoryHealthy) {
			anyHealthy = true;
			continue;
		}
		// pin-only and live-only cells don't have full sync/health info; treat
		// them as neutral (contribute nothing to the overall state, but we don't
		// flag them as unknown unless no other cell says anything useful).
		if (cell.source === "inventory") {
			hasUnknown = true;
		}
	}

	const overall: RowOverallStatus = hasDegraded
		? "degraded"
		: hasDrift
			? "drift"
			: anyHealthy
				? "healthy"
				: hasUnknown
					? "unknown"
					: "healthy"; // pin-only/live-only only → treat as healthy by default

	return { overall, updatedAt, hasPopulatedCell: true };
}
