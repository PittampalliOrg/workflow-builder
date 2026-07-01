import { isFailedValue, isPassingValue } from "./activity-tone";
import { BUNDLE_WAREHOUSE } from "./pipeline-model";
import type {
	PipelineActivity,
	PipelineModel,
	PipelineStage,
	PipelineWarehouse,
} from "./pipeline-types";
import type { GitOpsActivityEvent } from "$lib/types/gitops-activity";

// The 4-way tone scale + class tokens now live in `activity-tone.ts` (one source
// of truth shared by every surface). Re-exported here so existing importers keep
// working.
export { activityEventTone } from "./activity-tone";

type ActivityTarget = {
	warehouse: string;
	env: string | null;
};

export type ActivitySelection = { kind: "stage" | "warehouse" | "subscription"; id: string } | null;

// C3 — short-circuit cache: reuse the prior overlaid stage/warehouse object when
// neither its base (inventory) object nor its resolved activity changed, so
// xyflow node `data` keeps a stable reference and unchanged nodes don't re-render.
type StageCacheEntry = { base: PipelineStage; eventId: string | null; result: PipelineStage };
type WarehouseCacheEntry = { base: PipelineWarehouse; eventId: string | null; result: PipelineWarehouse };
const stageCache = new Map<string, StageCacheEntry>();
const warehouseCache = new Map<string, WarehouseCacheEntry>();

export function applyPipelineActivityOverlay(
	model: PipelineModel,
	events: GitOpsActivityEvent[],
): PipelineModel {
	if (events.length === 0) return model;

	const stageActivity = new Map<string, PipelineActivity>();
	const warehouseActivity = new Map<string, PipelineActivity>();

	for (const event of events) {
		const target = targetForEvent(event, model);
		if (!target) continue;
		const activity = toPipelineActivity(event);
		if (target.env) {
			const key = `${target.warehouse}::${target.env}`;
			const prev = stageActivity.get(key);
			if (!prev || activity.sequence > prev.sequence) stageActivity.set(key, activity);
		}
		const prevWarehouse = warehouseActivity.get(target.warehouse);
		if (!prevWarehouse || activity.sequence > prevWarehouse.sequence) {
			warehouseActivity.set(target.warehouse, activity);
		}
	}

	const stages = model.stages.map((stage): PipelineStage => {
		const activity = stageActivity.get(stage.name) ?? null;
		const eventId = activity?.eventId ?? null;
		const cached = stageCache.get(stage.name);
		if (cached && cached.base === stage && cached.eventId === eventId) return cached.result;
		const result = { ...stage, activity };
		stageCache.set(stage.name, { base: stage, eventId, result });
		return result;
	});

	const warehouses = model.warehouses.map((warehouse): PipelineWarehouse => {
		const activity = warehouseActivity.get(warehouse.name) ?? null;
		const eventId = activity?.eventId ?? null;
		const cached = warehouseCache.get(warehouse.name);
		if (cached && cached.base === warehouse && cached.eventId === eventId) return cached.result;
		const result = { ...warehouse, activity };
		warehouseCache.set(warehouse.name, { base: warehouse, eventId, result });
		return result;
	});

	return {
		...model,
		stages,
		warehouses,
		warehousesBySubsystem: regroupWarehouses(warehouses),
	};
}

/**
 * Warehouse + stage keys an event targets, for the live-flow motion
 * (`markFlowing`). Returns `[]` when the event doesn't correlate to any node.
 */
export function activityTargetKeys(event: GitOpsActivityEvent, model: PipelineModel): string[] {
	const target = targetForEvent(event, model);
	if (!target) return [];
	const keys = [target.warehouse];
	if (target.env) keys.push(`${target.warehouse}::${target.env}`);
	return keys;
}

function targetForEvent(event: GitOpsActivityEvent, model: PipelineModel): ActivityTarget | null {
	const correlation = event.correlation;
	const imageName = readString(correlation.imageName);
	const appName = readString(correlation.argocdApp) ?? event.resourceRef.name;
	const cluster =
		readString(correlation.cluster) ??
		envFromAppName(appName) ??
		envFromBranch(readString(correlation.branch));

	const isTekton = event.source === "tekton" || event.activityType.startsWith("tekton.");
	const isPromoter = event.source === "promoter" || event.activityType.startsWith("promoter.");

	// 1. Explicit image name → per-service warehouse. Tekton PipelineRuns run in
	//    ns `tekton-pipelines` (no cluster), but the `github-outer-loop` build IS
	//    the dev/hub lane's build step (ryzen has no Tekton build — it uses
	//    commit-pin), so a clusterless Tekton build is attributed to `dev` to light
	//    the `<svc>::dev` stage, not just the warehouse.
	if (imageName) return { warehouse: imageName, env: cluster ?? (isTekton ? "dev" : null) };

	// 2. Tekton without imageName → derive from imageRef basename, else gitSha match.
	if (isTekton) {
		const fromRef = warehouseFromImageRef(readString(correlation.imageRef));
		if (fromRef) return { warehouse: fromRef, env: cluster ?? "dev" };
		const fromSha = warehouseFromGitSha(readString(correlation.gitSha), model);
		if (fromSha) return { warehouse: fromSha, env: cluster ?? "dev" };
	}

	// 3. Promoter → release-pins bundle; env from hydratedSha, then branch/cluster.
	//    Do NOT default to dev: if env can't be resolved, attach to the bundle
	//    warehouse only (env: null) rather than silently mis-attributing to dev.
	if (isPromoter) {
		const env = envFromHydratedSha(readString(correlation.hydratedSha), model) ?? cluster;
		return { warehouse: BUNDLE_WAREHOUSE, env };
	}

	// 4. ArgoCD app name → service stage, else bundle.
	if (appName) {
		const parsed = parseAppName(appName);
		if (parsed) return parsed;
	}

	if (event.activityType === "argocd.application") {
		return { warehouse: BUNDLE_WAREHOUSE, env: cluster };
	}

	return null;
}

function toPipelineActivity(event: GitOpsActivityEvent): PipelineActivity {
	const failed = isFailedValue(event.phase) || isFailedValue(event.reason);
	const passing = !failed && (isPassingValue(event.phase) || isPassingValue(event.reason));
	return {
		eventId: event.eventId,
		sequence: event.sequence,
		source: event.source,
		activityType: event.activityType,
		phase: event.phase,
		reason: event.reason,
		message: event.message,
		observedAt: event.observedAt,
		// Freshness (`active`) is intentionally NOT baked — it's derived at render
		// from the shared clock via `pipelineActivityTone`, so the model doesn't
		// re-derive on every clock tick.
		passing,
		failed,
	};
}

/**
 * Strip the GHCR prefix + `@digest` / `:tag` from a full image ref, returning
 * the repo basename (our warehouse name). `ghcr.io/pittampalliorg/<repo>:tag`
 * → `<repo>`.
 */
export function warehouseFromImageRef(imageRef: string | null): string | null {
	if (!imageRef) return null;
	let ref = imageRef.trim();
	const at = ref.indexOf("@");
	if (at >= 0) ref = ref.slice(0, at);
	const slash = ref.lastIndexOf("/");
	const basename = slash >= 0 ? ref.slice(slash + 1) : ref;
	const colon = basename.indexOf(":");
	const repo = colon >= 0 ? basename.slice(0, colon) : basename;
	return repo.trim() || null;
}

// C4 — reverse sha→target indices, built once per base model (WeakMap-keyed) so
// gitSha / hydratedSha fallback correlation is O(1) instead of an O(stages) scan
// per uncorrelated event.
type ShaIndices = { gitSha: Map<string, string>; hydrated: Map<string, string> };
const shaIndexCache = new WeakMap<PipelineModel, ShaIndices>();

function shaPrefix(value: string | null | undefined): string | null {
	if (!value) return null;
	const match = value.toLowerCase().match(/[0-9a-f]{7,40}/);
	return match ? match[0].slice(0, 7) : null;
}

function shaIndices(model: PipelineModel): ShaIndices {
	const cached = shaIndexCache.get(model);
	if (cached) return cached;
	const gitSha = new Map<string, string>();
	const ambiguous = new Set<string>();
	const hydrated = new Map<string, string>();
	for (const stage of model.stages) {
		for (const candidate of [stage.desiredTag, stage.liveTag, stage.commitSha]) {
			const prefix = shaPrefix(candidate);
			if (!prefix) continue;
			const existing = gitSha.get(prefix);
			if (existing === undefined) gitSha.set(prefix, stage.warehouse);
			// Same prefix on TWO different warehouses (sha collision) → ambiguous;
			// don't guess. Same warehouse from multiple of its own tags is fine.
			else if (existing !== stage.warehouse) ambiguous.add(prefix);
		}
		const hydratedPrefix = shaPrefix(stage.promoterHydratedSha);
		if (hydratedPrefix && !hydrated.has(hydratedPrefix)) hydrated.set(hydratedPrefix, stage.env);
	}
	for (const prefix of ambiguous) gitSha.delete(prefix);
	const indices = { gitSha, hydrated };
	shaIndexCache.set(model, indices);
	return indices;
}

/**
 * Match a service warehouse whose pinned tag / live tag / commit sha embeds the
 * given gitSha (7-char prefix, last-resort correlation).
 */
export function warehouseFromGitSha(gitSha: string | null, model: PipelineModel): string | null {
	const short = shaPrefix(gitSha);
	return short ? (shaIndices(model).gitSha.get(short) ?? null) : null;
}

/**
 * Resolve the Promoter env from a hydrated sha that appears in a stage's
 * promoter hydrated sha (dev only today).
 */
function envFromHydratedSha(hydratedSha: string | null, model: PipelineModel): string | null {
	const short = shaPrefix(hydratedSha);
	return short ? (shaIndices(model).hydrated.get(short) ?? null) : null;
}

/**
 * Whether an event correlates to the given selected stage / warehouse, sharing
 * `targetForEvent`'s correlation logic so a chip-bearing node also shows
 * matching history.
 */
export function selectionMatchesEvent(
	event: GitOpsActivityEvent,
	selection: ActivitySelection,
	model: PipelineModel,
): boolean {
	if (!selection || selection.kind === "subscription") return false;
	const target = targetForEvent(event, model);
	if (!target) return false;
	if (selection.kind === "warehouse") {
		const name = selection.id.replace(/^warehouse\//, "");
		return target.warehouse === name;
	}
	// stage selection: `stage/<warehouse>::<env>`
	const id = selection.id.replace(/^stage\//, "");
	const sep = id.indexOf("::");
	if (sep < 0) return false;
	const warehouse = id.slice(0, sep);
	const env = id.slice(sep + 2);
	return target.warehouse === warehouse && (target.env === env || target.env === null);
}

/**
 * Newest-first, eventId-deduped, capped list of events matching the selection.
 */
export function eventsForSelection(
	events: GitOpsActivityEvent[],
	selection: ActivitySelection,
	model: PipelineModel,
	limit = 25,
): GitOpsActivityEvent[] {
	if (!selection || selection.kind === "subscription") return [];
	const byId = new Map<string, GitOpsActivityEvent>();
	for (const event of events) {
		if (selectionMatchesEvent(event, selection, model)) byId.set(event.eventId, event);
	}
	return [...byId.values()].sort((a, b) => b.sequence - a.sequence).slice(0, limit);
}

/**
 * Display label for an event: the correlation image name when present, then the
 * resource ref name, then the activity key (centralizes the deleted page-local
 * `eventTargetLabel`).
 */
export function activityEventLabel(event: GitOpsActivityEvent): string {
	return readString(event.correlation.imageName) ?? event.resourceRef.name ?? event.activityKey;
}

/**
 * Drawer-native selection for the node an event correlates to: the stage when
 * the resolved `${warehouse}::${env}` actually exists in the model, else the
 * warehouse, else null. Powers click-to-navigate from event rows.
 */
export function selectionForEvent(
	event: GitOpsActivityEvent,
	model: PipelineModel,
): ActivitySelection {
	const target = targetForEvent(event, model);
	if (!target) return null;
	if (target.env) {
		const stageName = `${target.warehouse}::${target.env}`;
		if (model.stages.some((s) => s.name === stageName)) {
			return { kind: "stage", id: `stage/${stageName}` };
		}
	}
	if (model.warehouses.some((w) => w.name === target.warehouse)) {
		return { kind: "warehouse", id: `warehouse/${target.warehouse}` };
	}
	return null;
}

const CHIP_FIELDS = [
	"imageName",
	"cluster",
	"branch",
	"pipelineRun",
	"argocdApp",
] as const;

/**
 * Readable correlation chips for an event — the breadcrumbs (image, cluster,
 * branch, run, shas) rendered as labels instead of raw JSON.
 */
export function correlationChips(
	event: GitOpsActivityEvent,
): { key: string; label: string }[] {
	const chips: { key: string; label: string }[] = [];
	for (const key of CHIP_FIELDS) {
		const value = readString(event.correlation[key]);
		if (value) chips.push({ key, label: value });
	}
	for (const key of ["gitSha", "hydratedSha"] as const) {
		const prefix = shaPrefix(readString(event.correlation[key]));
		if (prefix) chips.push({ key, label: prefix });
	}
	return chips;
}

function parseAppName(name: string | null | undefined): ActivityTarget | null {
	if (!name) return null;
	for (const env of ["dev", "staging", "ryzen"]) {
		const prefix = `${env}-`;
		if (name.startsWith(prefix)) {
			return { warehouse: name.slice(prefix.length), env };
		}
	}
	if (name === "spoke-dev-workflow-builder") return { warehouse: BUNDLE_WAREHOUSE, env: "dev" };
	return null;
}

function envFromAppName(name: string | null | undefined): string | null {
	return parseAppName(name)?.env ?? null;
}

function envFromBranch(branch: string | null): string | null {
	if (!branch) return null;
	if (branch.includes("spokes-dev")) return "dev";
	if (branch.includes("spokes-staging")) return "staging";
	if (branch.includes("ryzen")) return "ryzen";
	return null;
}

function readString(value: unknown): string | null {
	return typeof value === "string" && value.trim() ? value.trim() : null;
}

function regroupWarehouses(warehouses: PipelineWarehouse[]): Record<string, PipelineWarehouse[]> {
	const grouped: Record<string, PipelineWarehouse[]> = {};
	for (const warehouse of warehouses) {
		(grouped[warehouse.subsystem] ??= []).push(warehouse);
	}
	return grouped;
}
