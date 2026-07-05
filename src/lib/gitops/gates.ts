import type { EnvCell } from "$lib/gitops/service-matrix";
import type { GitOpsPrPreviewVerify } from "$lib/gitops/pr-preview-summary";
import { relativeTime, shortSha } from "$lib/utils/gitops-display";

export type GateStatus = "passed" | "pending" | "failed" | "unknown";

export type GateState = {
	status: GateStatus;
	label: string;
	tooltip: string;
};

/**
 * Window we give the PromotionStrategy's soak timer on `staging` after `dev`
 * reports Healthy. Mirrors TimedCommitStatus-workflow-builder-soak.yaml on the
 * hub (`dev: 0s`, `staging: 10m`). If the hub config changes, surface here
 * rather than hard-coding in the view.
 */
export const STAGING_SOAK_MS = 10 * 60 * 1000;

/**
 * Values the hub inventory and ArgoCD use to indicate a passing
 * promotion/health state. Both TitleCase (ArgoCD) and lowercase (hub
 * gitops-deployment-inventory) variants are accepted.
 */
export const PASSING_PROMOTION_STATES = new Set<string>([
	"Succeeded",
	"Healthy",
	"succeeded",
	"healthy",
	"success",
	"True",
]);

export function isPromotionPassing(phase: string | null | undefined): boolean {
	if (!phase) return false;
	return PASSING_PROMOTION_STATES.has(phase);
}

export type GateOptions = {
	/** Clock override so tests stay deterministic. */
	now?: () => number;
};

/**
 * Canary parity between ryzen and dev. Ryzen is an explicit local/autonomous
 * lane now, not the release source for dev. The comparison stays useful when
 * operators intentionally pin the same commit to ryzen and want to confirm
 * that dev's promoted release pin has caught up.
 */
export function releasePrGate(
	ryzen: EnvCell | null,
	dev: EnvCell | null,
	options: GateOptions = {},
): GateState {
	if (!ryzen || !dev) {
		return {
			status: "unknown",
			label: "no data",
			tooltip: !ryzen
				? "no ryzen data in inventory"
				: "no dev data in inventory",
		};
	}

	const ryzenSha = ryzen.commitSha ?? null;
	const devSha = dev.commitSha ?? null;

	if (!ryzenSha && !devSha) {
		return {
			status: "unknown",
			label: "no commit data",
			tooltip: "neither env exposes a commit sha yet",
		};
	}

	if (ryzenSha && devSha && ryzenSha === devSha) {
		const mergedAt = dev.updatedAt;
		return {
			status: "passed",
			label: mergedAt ? `aligned ${relativeTime(mergedAt)}` : "aligned",
			tooltip: `dev release pin matches ryzen canary source ${shortSha(ryzenSha)}`,
		};
	}

	return {
		status: "pending",
		label: "not aligned",
		tooltip: `ryzen canary source ${shortSha(ryzenSha)} differs from dev release pin ${shortSha(devSha)}`,
	};
}

/**
 * D2 Playwright-critic verdict on a per-PR preview, rendered next to the
 * preview step. `null` verify (flag off, or verify not started) collapses to
 * unknown so the chip stays quiet.
 */
export function prPreviewVerifyGate(verify: GitOpsPrPreviewVerify): GateState {
	if (!verify) {
		return {
			status: "unknown",
			label: "no verify",
			tooltip: "preview verify (Playwright critic) has not run",
		};
	}
	switch (verify.state) {
		case "completed":
			return {
				status: "passed",
				label: "verify passed",
				tooltip: verify.verdict ?? "Playwright critic completed",
			};
		case "failed":
			return {
				status: "failed",
				label: "verify failed",
				tooltip: verify.reason ?? verify.verdict ?? "Playwright critic reported a failure",
			};
		case "started":
			return {
				status: "pending",
				label: "verifying",
				tooltip: "Playwright critic run in progress",
			};
		case "skipped":
			return {
				status: "unknown",
				label: "verify skipped",
				tooltip: verify.reason ?? "preview verify was skipped",
			};
		default:
			return {
				status: "unknown",
				label: "no verify",
				tooltip: "preview verify state is unknown",
			};
	}
}

/**
 * Gate between dev and staging — the actual GitOps Promoter gate with both
 * `argocd-health` and `timer` commit statuses. The inventory exposes
 * `promotion.healthPhase` at aggregate granularity; we prefer that when
 * populated and fall back to `live.healthStatus` when it is still Unknown.
 * Soak timing is derived from `dev.updatedAt` (time the release merged on
 * dev); once 10 minutes elapse with dev Healthy, Promoter auto-merges onto
 * env/spokes-staging.
 */
export function argoGates(
	dev: EnvCell | null,
	staging: EnvCell | null,
	options: GateOptions = {},
): GateState {
	const now = options.now ?? Date.now;

	if (!dev || !staging) {
		return {
			status: "unknown",
			label: "no data",
			tooltip: !dev ? "no dev data in inventory" : "no staging data in inventory",
		};
	}

	const devSha = dev.commitSha ?? null;
	const stagingSha = staging.commitSha ?? null;

	if (devSha && stagingSha && devSha === stagingSha) {
		return {
			status: "passed",
			label: "gates passed",
			tooltip: `staging caught up with dev at ${shortSha(devSha)}`,
		};
	}

	const stagingPhase =
		staging.promotionHealth ?? staging.healthStatus ?? null;
	if (stagingPhase === "Failed" || stagingPhase === "Degraded") {
		return {
			status: "failed",
			label: `staging ${stagingPhase.toLowerCase()}`,
			tooltip: `staging PromotionStrategy reports ${stagingPhase}; auto-promotion blocked`,
		};
	}

	const devHealthy =
		(dev.healthStatus === "Healthy" || dev.healthStatus === "Succeeded") &&
		(dev.driftStatus === "in_sync" || dev.syncStatus === "Synced");
	if (!devHealthy) {
		const healthLabel = dev.healthStatus ?? "Unknown";
		const syncLabel = dev.syncStatus ?? dev.driftStatus ?? "Unknown";
		return {
			status: "pending",
			label: "waiting on dev health",
			tooltip: `dev must be Healthy and Synced before the soak timer starts (currently ${healthLabel}/${syncLabel})`,
		};
	}

	const mergedAt = dev.updatedAt ? new Date(dev.updatedAt).getTime() : null;
	if (mergedAt == null || Number.isNaN(mergedAt)) {
		return {
			status: "pending",
			label: "soak timer unknown",
			tooltip: "dev is healthy but inventory has not reported the release-merge timestamp yet",
		};
	}

	const remaining = STAGING_SOAK_MS - (now() - mergedAt);
	if (remaining > 0) {
		const mins = Math.max(1, Math.ceil(remaining / 60_000));
		return {
			status: "pending",
			label: `soaking ${mins}m`,
			tooltip: `dev is healthy; staging auto-promotes in ${mins} minute${mins === 1 ? "" : "s"} (10m soak)`,
		};
	}

	return {
		status: "pending",
		label: "promotion starting",
		tooltip: "soak elapsed; waiting on GitOps Promoter to auto-merge onto env/spokes-staging",
	};
}
