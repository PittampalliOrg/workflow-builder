export function shortSha(sha: string | null | undefined): string {
	return sha ? sha.slice(0, 8) : "—";
}

export function shortImage(image: string): string {
	if (image.length <= 82) return image;
	const lastSlash = image.lastIndexOf("/");
	const lastColon = image.lastIndexOf(":");
	const hasTag = lastColon > lastSlash;
	if (!hasTag) return `${image.slice(0, 78)}...`;
	const repo = image.slice(0, lastColon);
	const tag = image.slice(lastColon + 1);
	const tail = `${repo.split("/").slice(-2).join("/")}:${tag}`;
	return tail.length <= 82 ? tail : `${tail.slice(0, 78)}...`;
}

export function shortImageId(imageID: string | null | undefined): string {
	if (!imageID) return "—";
	const digest = imageID.includes("@") ? imageID.split("@").pop() : imageID;
	if (!digest) return "—";
	if (digest.startsWith("sha256:")) return `sha256:${digest.slice(7, 19)}`;
	return digest.length <= 28 ? digest : `${digest.slice(0, 25)}...`;
}

export function shortDigest(digest: string | null | undefined): string {
	if (!digest) return "—";
	if (digest.startsWith("sha256:")) return `sha256:${digest.slice(7, 19)}`;
	return digest.length <= 20 ? digest : `${digest.slice(0, 17)}...`;
}

export function relativeTime(iso: string | null | undefined, now: number = Date.now()): string {
	const date = parseDate(iso);
	if (!date) return "—";

	const diff = now - date.getTime();
	const future = diff < 0;
	const abs = Math.abs(diff);
	const min = Math.floor(abs / 60_000);
	if (min < 1) return "now";
	if (min < 60) return future ? `in ${plural(min, "min")}` : `${plural(min, "min")} ago`;

	const hr = Math.floor(min / 60);
	if (hr < 24) return future ? `in ${plural(hr, "hour")}` : `${plural(hr, "hour")} ago`;

	if (!future) {
		const dayDiff = calendarDayDiff(date, new Date(now));
		if (dayDiff === 1) return `Yesterday at ${clockTime(date)}`;
		if (dayDiff > 1 && dayDiff < 7) {
			return `${weekday(date)} at ${clockTime(date)}`;
		}
	}

	return formatAbsoluteTime(iso, now);
}

export function formatAbsoluteTime(
	iso: string | null | undefined,
	now: number = Date.now(),
): string {
	const date = parseDate(iso);
	if (!date) return "—";
	const sameYear = date.getFullYear() === new Date(now).getFullYear();
	return new Intl.DateTimeFormat(undefined, {
		month: "short",
		day: "numeric",
		...(sameYear ? {} : { year: "numeric" }),
		hour: "numeric",
		minute: "2-digit",
	}).format(date);
}

function parseDate(iso: string | null | undefined): Date | null {
	if (!iso) return null;
	const date = new Date(iso);
	return Number.isNaN(date.getTime()) ? null : date;
}

function plural(value: number, unit: "min" | "hour"): string {
	if (unit === "min") return value === 1 ? "1 min" : `${value} mins`;
	return value === 1 ? "1 hour" : `${value} hours`;
}

function calendarDayDiff(older: Date, newer: Date): number {
	const olderStart = new Date(older.getFullYear(), older.getMonth(), older.getDate()).getTime();
	const newerStart = new Date(newer.getFullYear(), newer.getMonth(), newer.getDate()).getTime();
	return Math.round((newerStart - olderStart) / 86_400_000);
}

function clockTime(date: Date): string {
	return new Intl.DateTimeFormat(undefined, {
		hour: "numeric",
		minute: "2-digit",
	}).format(date);
}

function weekday(date: Date): string {
	return new Intl.DateTimeFormat(undefined, { weekday: "short" }).format(date);
}

export type StatusVariant = "secondary" | "destructive" | "outline";

const PASSING_STATUSES = new Set([
	"Synced",
	"Healthy",
	"Succeeded",
	"True",
	"success",
	"healthy",
	"succeeded",
]);

const FAILING_STATUSES = new Set([
	"OutOfSync",
	"Degraded",
	"Failed",
	"Failure",
	"False",
	"failed",
	"failure",
]);

export function statusVariant(status: string | null | undefined): StatusVariant {
	if (!status) return "outline";
	if (PASSING_STATUSES.has(status)) return "secondary";
	if (FAILING_STATUSES.has(status)) return "destructive";
	return "outline";
}

export function driftLabel(status: string | null | undefined): string {
	if (status === "in_sync") return "In sync";
	if (status === "pending_rollout") return "Pending rollout";
	return status ? status.replaceAll("_", " ") : "Unknown";
}

export function driftVariant(status: string | null | undefined): StatusVariant {
	if (status === "in_sync") return "secondary";
	if (status === "pending_rollout" || status === "unknown") return "outline";
	return "destructive";
}

export function commitShaFromTag(tag: string | null | undefined): string | null {
	if (!tag) return null;
	const match = tag.match(/^git-([0-9a-f]{7,40})$/i);
	return match ? match[1].toLowerCase() : null;
}

/**
 * Display-friendly tag. Renders `git-<40-hex>` as `git-<8-hex>` so it fits on
 * one line in narrow cards; non-git tags pass through unless they exceed
 * `maxChars`, in which case they're truncated with an ellipsis.
 */
export function shortTag(tag: string | null | undefined, maxChars = 16): string {
	if (!tag) return "—";
	const sha = commitShaFromTag(tag);
	if (sha) return `git-${sha.slice(0, 8)}`;
	return tag.length <= maxChars ? tag : `${tag.slice(0, maxChars - 1)}…`;
}

export function formatDurationMs(ms: number | null | undefined): string {
	if (ms == null || !Number.isFinite(ms) || ms < 0) return "—";
	if (ms < 1000) return `${ms}ms`;
	const sec = Math.round(ms / 1000);
	if (sec < 60) return `${sec}s`;
	const min = Math.floor(sec / 60);
	const remSec = sec % 60;
	if (min < 60) return remSec === 0 ? `${min}m` : `${min}m ${remSec}s`;
	const hr = Math.floor(min / 60);
	return `${hr}h ${min % 60}m`;
}
