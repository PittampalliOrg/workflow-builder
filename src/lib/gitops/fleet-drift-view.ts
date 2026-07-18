/**
 * Pure view-model builders that join the services matrix (`ServiceRow[]`) with
 * the fleet-drift extras (`FleetDriftExtras` from `getFleetDriftExtras`) into
 * per-service render models for the GitOps services matrix:
 *
 *   - newest-built tag + in-flight PipelineRun,
 *   - pin freshness (relative age, amber past `PIN_AGE_AMBER_MS`),
 *   - pin vs workflow-builder origin/main HEAD (behind-main indicator),
 *   - the built → pinned → deployed image lineage stepper.
 *
 * Browser-safe, no I/O, unit-tested in `fleet-drift-view.test.ts`.
 */
import type {
	FleetDriftExtras,
	GitCommitMetadata,
} from "$lib/types/deployment-metadata";
import { commitShaFromTag } from "$lib/utils/gitops-display";

import type { EnvCell, EnvName, ServiceRow } from "./service-matrix";

/** Pin older than this renders amber — the outer loop normally bumps within hours. */
export const PIN_AGE_AMBER_MS = 48 * 60 * 60 * 1000;

export type PinVsMainStatus = "in-sync" | "behind-main" | "unknown";

/**
 * Prefix-tolerant SHA equality: pin tags may carry 7–40 hex chars while the
 * repo HEAD is always the full 40. Requires at least 7 chars on both sides.
 */
export function shasMatch(
	a: string | null | undefined,
	b: string | null | undefined,
): boolean {
	if (!a || !b) return false;
	const left = a.toLowerCase();
	const right = b.toLowerCase();
	if (left.length < 7 || right.length < 7) return false;
	return left.startsWith(right) || right.startsWith(left);
}

/**
 * Is the release pin's source commit the current workflow-builder main HEAD?
 * "behind-main" also covers the (rare) diverged case — either way the pinned
 * build is not what main currently is, which is the operator-relevant signal.
 */
export function pinVsMainStatus(
	pinSha: string | null,
	mainHead: GitCommitMetadata | null,
): PinVsMainStatus {
	if (!pinSha || !mainHead?.sha) return "unknown";
	return shasMatch(pinSha, mainHead.sha) ? "in-sync" : "behind-main";
}

/** GitHub compare deep link `pin...main`, or null without a pin SHA. */
export function compareToMainUrl(
	repoUrl: string,
	pinSha: string | null,
): string | null {
	if (!pinSha) return null;
	return `${repoUrl.replace(/\/+$/, "")}/compare/${pinSha}...main`;
}

export type FleetServiceDrift = {
	service: string;
	/** Newest pin-history tag (pin commits ARE build history). */
	newestBuiltTag: string | null;
	newestBuiltAt: string | null;
	/** Unfinished PipelineRun reported by the hub inventory, if any. */
	inFlightPipelineRun: string | null;
	/** Current release-pin tag (dev/staging desired). */
	pinTag: string | null;
	pinSha: string | null;
	pinUpdatedAt: string | null;
	pinAgeMs: number | null;
	/** True once the pin age crosses `PIN_AGE_AMBER_MS`. */
	pinStale: boolean;
	pinVsMain: PinVsMainStatus;
	/** GitHub compare link pin...main when behind. */
	compareUrl: string | null;
};

/** Release-pin tag for a row: dev desired first, then staging (same pin file). */
export function pinTagForRow(row: ServiceRow): string | null {
	return row.envs.dev?.tag ?? row.envs.staging?.tag ?? null;
}

/**
 * Join matrix rows with the extras feed. Every service in `rows` gets an
 * entry; a null/absent extras feed degrades to nulls (render as skeleton/em
 * dashes, never crash).
 */
export function buildFleetServiceDrift(
	rows: ServiceRow[],
	extras: FleetDriftExtras | null,
	options: { workflowBuilderRepoUrl: string; now?: number },
): Map<string, FleetServiceDrift> {
	const now = options.now ?? Date.now();
	const newestByService = new Map(
		(extras?.newestBuilt ?? []).map((entry) => [entry.service, entry]),
	);
	const ageByService = new Map(
		(extras?.pinAges ?? []).map((entry) => [entry.service, entry]),
	);
	const mainHead = extras?.workflowBuilderMainHead ?? null;

	const out = new Map<string, FleetServiceDrift>();
	for (const row of rows) {
		const newest = newestByService.get(row.service) ?? null;
		const age = ageByService.get(row.service) ?? null;
		const pinTag = pinTagForRow(row);
		const pinSha =
			row.envs.dev?.commitSha ??
			row.envs.staging?.commitSha ??
			commitShaFromTag(pinTag);
		const ageMs =
			age?.ageMs ??
			(age?.updatedAt ? Math.max(0, now - Date.parse(age.updatedAt)) : null);
		const vsMain = pinVsMainStatus(pinSha, mainHead);
		out.set(row.service, {
			service: row.service,
			newestBuiltTag: newest?.newestTag ?? null,
			newestBuiltAt: newest?.newestPinCommittedAt ?? null,
			inFlightPipelineRun: newest?.inFlightPipelineRun ?? null,
			pinTag,
			pinSha,
			pinUpdatedAt: age?.updatedAt ?? null,
			pinAgeMs: ageMs,
			pinStale: ageMs != null && ageMs > PIN_AGE_AMBER_MS,
			pinVsMain: vsMain,
			compareUrl:
				vsMain === "behind-main"
					? compareToMainUrl(options.workflowBuilderRepoUrl, pinSha)
					: null,
		});
	}
	return out;
}

export type LineageStepState = "done" | "active" | "pending" | "missing";

export type LineageStep = {
	id: string;
	label: string;
	tag: string | null;
	at: string | null;
	state: LineageStepState;
	/** Extra one-liner under the tag (e.g. env sync state). */
	detail: string | null;
};

function envCellTag(cell: EnvCell): string | null {
	// Prefer the live image tag when reported; fall back to the desired tag.
	const liveTag = cell.liveImage
		? (cell.liveImage.split("@", 1)[0]?.split(":").pop() ?? null)
		: null;
	return liveTag && liveTag !== cell.liveImage ? liveTag : (cell.tag ?? null);
}

function deployedState(cell: EnvCell): LineageStepState {
	if (cell.syncStatus === "OutOfSync" || cell.driftStatus === "pending_rollout") {
		return "pending";
	}
	if (cell.syncStatus === "Synced" || cell.driftStatus === "in_sync") return "done";
	return cell.tag ? "done" : "missing";
}

function deployedDetail(cell: EnvCell): string | null {
	if (cell.syncStatus === "OutOfSync") return "out of sync";
	if (cell.driftStatus === "pending_rollout") return "rollout pending";
	if (cell.healthStatus === "Degraded") return "degraded";
	if (cell.syncStatus === "Synced") return "synced";
	return null;
}

/**
 * Built → Pinned → Deployed(per env) stepper for the expanded matrix row.
 * Sandbox-only services stop at "Pinned" (they have no Deployment; the pin is
 * what a fresh sandbox launches).
 */
export function buildLineage(
	row: ServiceRow,
	drift: FleetServiceDrift | null,
	visibleEnvs: readonly EnvName[],
): LineageStep[] {
	const steps: LineageStep[] = [];
	steps.push({
		id: "built",
		label: "Built",
		tag: drift?.newestBuiltTag ?? null,
		at: drift?.newestBuiltAt ?? null,
		state: drift?.inFlightPipelineRun
			? "active"
			: drift?.newestBuiltTag
				? "done"
				: "missing",
		detail: drift?.inFlightPipelineRun ? "build in flight" : null,
	});
	const pinTag = drift?.pinTag ?? pinTagForRow(row);
	steps.push({
		id: "pinned",
		label: "Pinned",
		tag: pinTag,
		at: drift?.pinUpdatedAt ?? null,
		state: pinTag ? "done" : "missing",
		detail:
			drift?.pinVsMain === "behind-main"
				? "behind main"
				: drift?.pinVsMain === "in-sync"
					? "at main HEAD"
					: null,
	});
	if (row.specialCase === "sandbox-only") return steps;
	for (const env of visibleEnvs) {
		const cell = row.envs[env];
		if (!cell) continue;
		steps.push({
			id: `deployed-${env}`,
			label: env,
			tag: envCellTag(cell),
			at: cell.updatedAt,
			state: deployedState(cell),
			detail: deployedDetail(cell),
		});
	}
	return steps;
}

export type FleetDriftSummary = {
	stalePins: number;
	behindMain: number;
	buildsInFlight: number;
};

/** Header chips for the matrix: how much of the fleet needs a look. */
export function summarizeFleetDrift(
	drift: Map<string, FleetServiceDrift>,
): FleetDriftSummary {
	let stalePins = 0;
	let behindMain = 0;
	let buildsInFlight = 0;
	for (const entry of drift.values()) {
		if (entry.pinStale) stalePins += 1;
		if (entry.pinVsMain === "behind-main") behindMain += 1;
		if (entry.inFlightPipelineRun) buildsInFlight += 1;
	}
	return { stalePins, behindMain, buildsInFlight };
}

/** Compact "3d", "5h", "12m" age label for the pin-age cell. */
export function compactAgeLabel(ageMs: number | null): string {
	if (ageMs == null) return "—";
	const minutes = Math.floor(ageMs / 60_000);
	if (minutes < 1) return "<1m";
	if (minutes < 60) return `${minutes}m`;
	const hours = Math.floor(minutes / 60);
	if (hours < 24) return `${hours}h`;
	return `${Math.floor(hours / 24)}d`;
}
