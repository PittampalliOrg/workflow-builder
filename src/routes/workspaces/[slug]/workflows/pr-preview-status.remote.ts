import { error } from "@sveltejs/kit";
import { getRequestEvent, query } from "$app/server";
import { getApplicationAdapters } from "$lib/server/application";
import { getApplicationAdapterConfig } from "$lib/server/application/config";
import type { PrPreviewStatus } from "$lib/server/application/ports";

export type PrPreviewStatusView = {
	status: PrPreviewStatus;
	prUrl: string;
};

/**
 * Snapshot of a promoted PR's preview pipeline for the run-cockpit / dev
 * promote chain. Reads through the resume-safe `prPreviews.peek()` (A2) — a
 * browser poll must NEVER kick a pipeline. Returns null when PR previews are
 * disabled so the chain degrades to a bare PR link.
 */
export const getPrPreviewStatus = query(
	"unchecked",
	async (prNumber: number): Promise<PrPreviewStatusView | null> => {
		const event = getRequestEvent();
		if (!event.locals.session?.userId) error(401, "Authentication required");
		const config = getApplicationAdapterConfig();
		if (!config.prPreviewsEnabled) return null;
		const status = await getApplicationAdapters().prPreviews.peek(prNumber);
		return {
			status,
			prUrl: `https://github.com/${config.prPreviewRepo}/pull/${prNumber}`,
		};
	},
);
