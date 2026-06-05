/**
 * The single source of truth for GitOps activity TONE — the failed / passing /
 * active / neutral scale and its Tailwind class tokens — shared by every
 * real-time surface (graph node chips, list rows, the drawer feed, the activity
 * feed). Centralizing it ends the per-component colour drift and keeps the
 * freshness window in lock-step with `toPipelineActivity`.
 *
 * Freshness (`active`) is computed at RENDER time from a caller-supplied `now`
 * (the shared `nowTick()` clock) so the model never re-derives just to flip a
 * freshness flag.
 */
import type { GitOpsActivityEvent } from "$lib/types/gitops-activity";
import type { PipelineActivity } from "./pipeline-types";

export type ActivityTone = "failed" | "passing" | "active" | "neutral";

/** An event is "active" (fresh + in-progress) for this long after it was observed. */
export const ACTIVITY_WINDOW_MS = 30 * 60_000;

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

function norm(value: string | null | undefined): string | null {
	return value ? value.replaceAll(/\s+/g, "").toLowerCase() : null;
}

export function isFailedValue(value: string | null | undefined): boolean {
	const n = norm(value);
	return n ? TERMINAL_FAIL.has(n) : false;
}

export function isPassingValue(value: string | null | undefined): boolean {
	const n = norm(value);
	return n ? TERMINAL_PASS.has(n) : false;
}

function freshnessTone(observedAt: string, now: number): "active" | "neutral" {
	const observed = Date.parse(observedAt);
	return Number.isFinite(observed) && now - observed <= ACTIVITY_WINDOW_MS ? "active" : "neutral";
}

/** Tone for a raw stream event (feed / drawer). */
export function activityEventTone(event: GitOpsActivityEvent, now: number = Date.now()): ActivityTone {
	if (isFailedValue(event.phase) || isFailedValue(event.reason)) return "failed";
	if (isPassingValue(event.phase) || isPassingValue(event.reason)) return "passing";
	return freshnessTone(event.observedAt, now);
}

/** Tone for a baked overlay activity (graph nodes / list). `passing`/`failed` are
 *  pre-computed (time-independent); only freshness needs the shared clock. */
export function pipelineActivityTone(
	activity: Pick<PipelineActivity, "failed" | "passing" | "observedAt">,
	now: number = Date.now(),
): ActivityTone {
	if (activity.failed) return "failed";
	if (activity.passing) return "passing";
	return freshnessTone(activity.observedAt, now);
}

export type ToneClasses = {
	/** Left-spine / outline border colour. */
	border: string;
	/** Soft background tint. */
	bg: string;
	/** Foreground text colour. */
	text: string;
	/** Solid dot / rule fill colour. */
	dot: string;
};

const TONE_CLASSES: Record<ActivityTone, ToneClasses> = {
	failed: {
		border: "border-destructive",
		bg: "bg-destructive/10",
		text: "text-destructive",
		dot: "bg-destructive",
	},
	passing: {
		border: "border-emerald-500",
		bg: "bg-emerald-500/10",
		text: "text-emerald-700 dark:text-emerald-300",
		dot: "bg-emerald-500",
	},
	active: {
		border: "border-sky-500",
		bg: "bg-sky-500/10",
		text: "text-sky-700 dark:text-sky-300",
		dot: "bg-sky-500",
	},
	neutral: {
		border: "border-muted-foreground/40",
		bg: "bg-muted",
		text: "text-muted-foreground",
		dot: "bg-muted-foreground/50",
	},
};

export function toneClasses(tone: ActivityTone): ToneClasses {
	return TONE_CLASSES[tone];
}
