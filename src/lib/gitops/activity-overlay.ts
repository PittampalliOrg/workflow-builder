import { BUNDLE_WAREHOUSE } from "./pipeline-model";
import type {
	PipelineActivity,
	PipelineModel,
	PipelineStage,
	PipelineWarehouse,
} from "./pipeline-types";
import type { GitOpsActivityEvent } from "$lib/types/gitops-activity";

const ACTIVITY_WINDOW_MS = 30 * 60_000;
const TERMINAL_PASS = new Set([
	"succeeded",
	"success",
	"successful",
	"healthy",
	"synced",
	"ready",
	"true",
]);
const TERMINAL_FAIL = new Set([
	"failed",
	"failure",
	"false",
	"degraded",
	"error",
	"errored",
	"cancelled",
	"canceled",
	"outofsync",
]);

type ActivityTarget = {
	warehouse: string;
	env: string | null;
};

export function applyPipelineActivityOverlay(
	model: PipelineModel,
	events: GitOpsActivityEvent[],
	now = Date.now(),
): PipelineModel {
	if (events.length === 0) return model;

	const stageActivity = new Map<string, PipelineActivity>();
	const warehouseActivity = new Map<string, PipelineActivity>();

	for (const event of events) {
		const target = targetForEvent(event);
		if (!target) continue;
		const activity = toPipelineActivity(event, now);
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
		if (!activity) return { ...stage, activity: null };
		return {
			...stage,
			activity,
			health: activity.failed ? "Degraded" : activity.active ? "Progressing" : stage.health,
			awaitingReconcile: stage.awaitingReconcile || activity.active,
			updatedAt: activity.observedAt ?? stage.updatedAt,
		};
	});

	const warehouses = model.warehouses.map((warehouse): PipelineWarehouse => {
		const activity = warehouseActivity.get(warehouse.name) ?? null;
		if (!activity) return { ...warehouse, activity: null };
		return {
			...warehouse,
			activity,
			reconciling: warehouse.reconciling || activity.active,
			hasError: warehouse.hasError || activity.failed,
		};
	});

	return {
		...model,
		stages,
		warehouses,
		warehousesBySubsystem: regroupWarehouses(warehouses),
	};
}

function targetForEvent(event: GitOpsActivityEvent): ActivityTarget | null {
	const correlation = event.correlation;
	const imageName = readString(correlation.imageName);
	const appName = readString(correlation.argocdApp) ?? event.resourceRef.name;
	const cluster =
		readString(correlation.cluster) ??
		envFromAppName(appName) ??
		envFromBranch(readString(correlation.branch));

	if (imageName) return { warehouse: imageName, env: cluster };

	if (event.source === "promoter" || event.activityType.startsWith("promoter.")) {
		return { warehouse: BUNDLE_WAREHOUSE, env: cluster ?? "dev" };
	}

	if (appName) {
		const parsed = parseAppName(appName);
		if (parsed) return parsed;
	}

	if (event.activityType === "argocd.application") {
		return { warehouse: BUNDLE_WAREHOUSE, env: cluster };
	}

	return null;
}

function toPipelineActivity(event: GitOpsActivityEvent, now: number): PipelineActivity {
	const failed = isFailed(event.phase) || isFailed(event.reason);
	const passing = isPassing(event.phase) || isPassing(event.reason);
	const observed = new Date(event.observedAt).getTime();
	const fresh = Number.isFinite(observed) && now - observed <= ACTIVITY_WINDOW_MS;
	return {
		eventId: event.eventId,
		sequence: event.sequence,
		source: event.source,
		activityType: event.activityType,
		phase: event.phase,
		reason: event.reason,
		message: event.message,
		observedAt: event.observedAt,
		active: fresh && !failed && !passing,
		failed,
	};
}

function parseAppName(name: string | null | undefined): ActivityTarget | null {
	if (!name) return null;
	for (const env of ["ryzen", "dev", "staging"]) {
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

function isFailed(value: string | null | undefined): boolean {
	return value ? TERMINAL_FAIL.has(value.replaceAll(/\s+/g, "").toLowerCase()) : false;
}

function isPassing(value: string | null | undefined): boolean {
	return value ? TERMINAL_PASS.has(value.replaceAll(/\s+/g, "").toLowerCase()) : false;
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
