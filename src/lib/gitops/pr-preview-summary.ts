// Client-safe wire type for a per-PR preview in the GitOps views. Mapped from
// the resume-safe `prPreviews.listStatuses()` read (application/pr-previews) in
// the page load — NEVER from a status probe, so a browser poll can't kick a
// pipeline. Kept out of $lib/server so the change-journey model + gates can
// import it without pulling server code into the client bundle.

export type GitOpsPrPreviewState =
	| "provisioning"
	| "seeding"
	| "ready"
	| "error"
	| "capacity_full"
	| "absent"
	| "unknown";

export type GitOpsPrPreviewVerify = {
	state: "started" | "skipped" | "completed" | "failed";
	executionId: string | null;
	reason: string | null;
	verdict: string | null;
} | null;

export type GitOpsPrPreviewSummary = {
	prNumber: number;
	alias: string;
	url: string | null;
	state: GitOpsPrPreviewState;
	headSha: string | null;
	services: string[];
	error: string | null;
	verify: GitOpsPrPreviewVerify;
	updatedAt: string | null;
	/** GitHub PR URL, decorated in the load from `prPreviewRepo`. */
	prUrl: string | null;
};

/** Shape of `prPreviews.listStatuses()` (application/pr-previews `PrPreviewStatus`)
 * — declared structurally so this client-safe module doesn't import server code. */
export type PrPreviewStatusInput = Omit<GitOpsPrPreviewSummary, "prUrl">;

/** Decorate resume-safe preview statuses with a GitHub PR URL. Pure; called from
 * the page load / remote fn so routes never reach the config directly. */
export function mapPrPreviewStatuses(
	statuses: readonly PrPreviewStatusInput[],
	prPreviewRepo: string,
): GitOpsPrPreviewSummary[] {
	const base = prPreviewRepo.trim().replace(/\/+$/, "");
	return statuses.map((status) => ({
		...status,
		services: [...status.services],
		prUrl: base ? `https://github.com/${base}/pull/${status.prNumber}` : null,
	}));
}
