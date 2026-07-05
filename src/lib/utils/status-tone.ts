/**
 * Single status→tone classifier for every status string the UI renders
 * (sessions, workflow runs, previews, fleet items, archives). Replaces the
 * divergent per-page helpers (Fleet `statusTone`, workflows `statusColor`,
 * `execution-status-badge`) with one palette:
 *
 *   success → emerald · active → sky · pending → indigo
 *   warning → amber   · danger → rose · muted → muted-foreground
 *
 * Reconciled divergences (previously inconsistent across pages): running is
 * sky (run-cockpit convention; Fleet used emerald), cancelled/capacity states
 * are amber, terminated/idle/finished are muted.
 */
export type StatusTone = "success" | "active" | "pending" | "warning" | "danger" | "muted";

const EXACT: Record<string, StatusTone> = {
	// success family
	success: "success",
	succeeded: "success",
	completed: "success",
	ready: "success",
	passed: "success",
	healthy: "success",
	// active family
	running: "active",
	active: "active",
	seeding: "active",
	resuming: "active",
	streaming: "active",
	// pending family
	pending: "pending",
	queued: "pending",
	starting: "pending",
	provisioning: "pending",
	claiming: "pending",
	scheduled: "pending",
	// warning family
	cancelled: "warning",
	canceled: "warning",
	capacity_full: "warning",
	degraded: "warning",
	paused: "warning",
	slept: "warning",
	// danger family
	error: "danger",
	failed: "danger",
	failure: "danger",
	timeout: "danger",
	// muted family
	terminated: "muted",
	stopped: "muted",
	idle: "muted",
	finished: "muted",
	archived: "muted",
	absent: "muted",
	unknown: "muted",
	dormant: "muted",
};

export function resolveStatusTone(status: string | null | undefined): StatusTone {
	if (!status) return "muted";
	const s = status.toLowerCase();
	const exact = EXACT[s];
	if (exact) return exact;
	// Substring heuristics (from the Fleet's classifier) for compound statuses
	// like "InferenceRunning" or "grading". Order matters: failure words first.
	if (s.includes("fail") || s.includes("error") || s.includes("timeout")) return "danger";
	if (s.includes("cancel")) return "warning";
	if (s.includes("terminat") || s.includes("finish")) return "muted";
	if (s.includes("reschedul") || s.includes("queue") || s.includes("start") || s.includes("pend"))
		return "pending";
	if (s.includes("run") || s.includes("infer") || s.includes("evaluat") || s.includes("grad"))
		return "active";
	if (s.includes("succe") || s.includes("complet") || s.includes("ready")) return "success";
	return "muted";
}

/** Text-only styling (Fleet row style). */
export function statusToneTextClass(tone: StatusTone): string {
	switch (tone) {
		case "success":
			return "text-emerald-600 dark:text-emerald-400";
		case "active":
			return "text-sky-600 dark:text-sky-400";
		case "pending":
			return "text-indigo-600 dark:text-indigo-400";
		case "warning":
			return "text-amber-600 dark:text-amber-400";
		case "danger":
			return "text-rose-600 dark:text-rose-400";
		default:
			return "text-muted-foreground";
	}
}

/** Bordered pill styling (execution-badge style, with dark-mode pairs). */
export function statusTonePillClass(tone: StatusTone): string {
	switch (tone) {
		case "success":
			return "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300";
		case "active":
			return "border-sky-500/30 bg-sky-500/10 text-sky-700 dark:text-sky-300";
		case "pending":
			return "border-indigo-500/30 bg-indigo-500/10 text-indigo-700 dark:text-indigo-300";
		case "warning":
			return "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300";
		case "danger":
			return "border-rose-500/30 bg-rose-500/10 text-rose-700 dark:text-rose-300";
		default:
			return "border-border bg-muted text-muted-foreground";
	}
}

/** Display label: "completed" → "Success", else capitalized status. */
export function statusToneLabel(status: string): string {
	const s = status.toLowerCase();
	if (s === "completed" || s === "succeeded") return "Success";
	if (s === "capacity_full") return "Capacity full";
	return s.charAt(0).toUpperCase() + s.slice(1);
}
