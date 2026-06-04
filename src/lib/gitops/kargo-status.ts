/**
 * Status + colour primitives ported from Kargo's open-source UI so our GitOps
 * pipeline view matches Kargo's visual language exactly.
 *
 * Source of truth (Apache-2.0, akuity/kargo):
 *  - ui/src/features/common/health-status/{health-status-icon.tsx,utils.ts}
 *  - ui/src/features/common/promotion-status/promotion-status-icon.tsx
 *  - ui/src/features/stage/verification-icon.tsx
 *
 * Kargo uses FontAwesome; we map each icon to its closest @lucide/svelte glyph
 * and keep Kargo's exact hex colours (Tailwind's green-500/red-500 are close but
 * not identical, so we expose the literal hexes for true parity).
 */
import {
	Ban,
	Circle,
	CircleAlert,
	CircleCheck,
	CircleHelp,
	Heart,
	HeartCrack,
	Hourglass,
	LoaderCircle,
} from "@lucide/svelte";
import type { Component } from "svelte";

/** Exact Kargo hex tokens (mirrors antd theme.defaultSeed + the helper switches). */
export const KARGO_COLORS = {
	healthy: "#52c41a",
	degraded: "#f5222d",
	progressing: "#0dabea",
	unknown: "#faad14",
	neutral: "#ccc",
	success: "#52c41a",
	error: "#ff4d4f",
	pending: "#aaa",
} as const;

export type KargoStatusVisual = {
	color: string;
	icon: Component;
	spin: boolean;
	label: string;
};

// ── Health ──────────────────────────────────────────────────────────────────
// Our ArgoCD health uses the same vocabulary as Kargo, so this maps 1:1 onto
// EnvCell.healthStatus ("Healthy" | "Progressing" | "Degraded" | "Unknown").

export enum HealthStatus {
	HEALTHY = "Healthy",
	DEGRADED = "Degraded",
	PROGRESSING = "Progressing",
	UNHEALTHY = "Unhealthy",
	UNKNOWN = "Unknown",
	UNDEFINED = "",
}

export function healthStatusToEnum(status?: string | null): HealthStatus {
	switch (status) {
		case HealthStatus.HEALTHY:
			return HealthStatus.HEALTHY;
		case HealthStatus.PROGRESSING:
			return HealthStatus.PROGRESSING;
		case HealthStatus.DEGRADED:
			return HealthStatus.DEGRADED;
		case HealthStatus.UNHEALTHY:
			return HealthStatus.UNHEALTHY;
		case HealthStatus.UNKNOWN:
			return HealthStatus.UNKNOWN;
		default:
			return HealthStatus.UNDEFINED;
	}
}

export function healthColor(status?: string | null): string {
	switch (healthStatusToEnum(status)) {
		case HealthStatus.HEALTHY:
			return KARGO_COLORS.healthy;
		case HealthStatus.DEGRADED:
		case HealthStatus.UNHEALTHY:
			return KARGO_COLORS.degraded;
		case HealthStatus.PROGRESSING:
			return KARGO_COLORS.progressing;
		case HealthStatus.UNKNOWN:
			return KARGO_COLORS.unknown;
		default:
			return KARGO_COLORS.neutral;
	}
}

export function healthVisual(status?: string | null): KargoStatusVisual {
	const enumValue = healthStatusToEnum(status);
	const color = healthColor(status);
	switch (enumValue) {
		case HealthStatus.HEALTHY:
			return { color, icon: Heart, spin: false, label: "Healthy" };
		case HealthStatus.DEGRADED:
		case HealthStatus.UNHEALTHY:
			return { color, icon: HeartCrack, spin: false, label: status || "Degraded" };
		case HealthStatus.PROGRESSING:
			return { color, icon: LoaderCircle, spin: true, label: "Progressing" };
		case HealthStatus.UNKNOWN:
			return { color, icon: CircleHelp, spin: false, label: "Unknown" };
		default:
			return { color, icon: Circle, spin: false, label: "No data" };
	}
}

// ── Promotion phase ─────────────────────────────────────────────────────────

export type PromotionPhase =
	| "Pending"
	| "Running"
	| "Succeeded"
	| "Failed"
	| "Errored"
	| "Aborted"
	| "";

export function promotionVisual(phase?: string | null): KargoStatusVisual | null {
	if (!phase) return null;
	switch (phase) {
		case "Succeeded":
			return { color: KARGO_COLORS.success, icon: CircleCheck, spin: false, label: "Succeeded" };
		case "Failed":
		case "Errored":
			return { color: KARGO_COLORS.error, icon: CircleAlert, spin: false, label: phase };
		case "Running":
			return { color: KARGO_COLORS.pending, icon: LoaderCircle, spin: true, label: "Running" };
		case "Aborted":
			return { color: KARGO_COLORS.pending, icon: Ban, spin: false, label: "Aborted" };
		case "Pending":
		default:
			return { color: KARGO_COLORS.pending, icon: Hourglass, spin: false, label: phase || "Pending" };
	}
}

// ── Verification phase ──────────────────────────────────────────────────────

export type VerificationPhase =
	| "Successful"
	| "Failed"
	| "Error"
	| "Aborted"
	| "Running"
	| "Pending"
	| "";

export function verificationVisual(phase?: string | null): KargoStatusVisual | null {
	if (!phase) return null;
	switch (phase) {
		case "Successful":
			return { color: KARGO_COLORS.success, icon: CircleCheck, spin: false, label: "Successful" };
		case "Failed":
		case "Error":
		case "Aborted":
			return { color: KARGO_COLORS.error, icon: CircleAlert, spin: false, label: phase };
		case "Running":
			return { color: KARGO_COLORS.pending, icon: LoaderCircle, spin: true, label: "Running" };
		case "Pending":
		default:
			return { color: KARGO_COLORS.pending, icon: Hourglass, spin: false, label: phase || "Pending" };
	}
}
