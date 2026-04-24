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
	if (!iso) return "—";
	const diff = Math.max(0, now - new Date(iso).getTime());
	const min = Math.floor(diff / 60_000);
	if (min < 1) return "now";
	if (min < 60) return `${min}m ago`;
	const hr = Math.floor(min / 60);
	if (hr < 24) return `${hr}h ago`;
	return `${Math.floor(hr / 24)}d ago`;
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
