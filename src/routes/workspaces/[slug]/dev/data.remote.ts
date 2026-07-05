import { command, getRequestEvent, query } from "$app/server";
import { error } from "@sveltejs/kit";
import { getApplicationAdapters } from "$lib/server/application";
import { getApplicationAdapterConfig } from "$lib/server/application/config";
import type { PreviewArchiveResult } from "$lib/server/application/preview-archive";
import type { PrPreviewStatus } from "$lib/server/application/ports";
import { safePreviewName } from "$lib/types/dev-previews";
import type {
	PreviewSleepResult,
	PreviewWakeResult,
	PrPreviewListItem,
	VclusterLaunchResult,
	VclusterPreviewCounts,
	VclusterPreviewSummary,
} from "$lib/types/dev-previews";
import type { DevEnvironmentGroupReadModel } from "$lib/server/application/ports";

/** Auth guard for the Dev-hub reads/mutations (mirrors the REST routes' 401). */
function requireSession() {
	const event = getRequestEvent();
	const session = event.locals.session;
	if (!session?.userId) error(401, "Authentication required");
	return session;
}

function toPrPreviewListItem(s: PrPreviewStatus, repo: string): PrPreviewListItem {
	return {
		prNumber: s.prNumber,
		alias: s.alias,
		url: s.url,
		prUrl: `https://github.com/${repo}/pull/${s.prNumber}`,
		state: s.state,
		headSha: s.headSha,
		services: s.services,
		error: s.error,
		verify: s.verify
			? { state: s.verify.state, reason: s.verify.reason, verdict: s.verify.verdict }
			: null,
		updatedAt: s.updatedAt,
	};
}

/** The dev environment grid (one entry per execution). */
export const getDevEnvironmentGroups = query(
	async (): Promise<DevEnvironmentGroupReadModel[]> => {
		const session = requireSession();
		return getApplicationAdapters().workflowData.listDevEnvironmentGroups({
			projectId: session.projectId ?? null,
		});
	},
);

/** Active Tier-2 vcluster previews + capacity counts (SEA-backed, list-only). */
export const getVclusterPreviews = query(
	async (): Promise<{ previews: VclusterPreviewSummary[]; counts: VclusterPreviewCounts | null }> => {
		requireSession();
		return getApplicationAdapters().vclusterPreviews.list();
	},
);

/**
 * D1 per-PR previews for the hub panel. STRICTLY the resume-safe
 * `listStatuses()` snapshot — a browser poll must never kick a pipeline. Off
 * (flag) → `{enabled:false}` so the panel renders its placeholder.
 */
export const getPrPreviews = query(
	async (): Promise<{ enabled: boolean; items: PrPreviewListItem[] }> => {
		requireSession();
		const config = getApplicationAdapterConfig();
		if (!config.prPreviewsEnabled) return { enabled: false, items: [] };
		const statuses = await getApplicationAdapters().prPreviews.listStatuses();
		return {
			enabled: true,
			items: statuses.map((s) => toPrPreviewListItem(s, config.prPreviewRepo)),
		};
	},
);

/** Launch a preview (claim-first, capacity-gated cold fallback). Refusal is data. */
export const launchPreview = command(
	"unchecked",
	async (input: { name: string }): Promise<VclusterLaunchResult> => {
		const session = requireSession();
		const name = safePreviewName(input?.name ?? "");
		if (!name || name === "preview") error(400, "A preview name is required");
		return getApplicationAdapters().vclusterPreviews.launch({ name, user: session.userId });
	},
);

/** Sleep a preview (scale down). 409 → typed refusal (protected / pool-member). */
export const sleepPreview = command(
	"unchecked",
	async (input: { name: string }): Promise<PreviewSleepResult> => {
		requireSession();
		return getApplicationAdapters().vclusterPreviews.sleep(input.name);
	},
);

/** Wake a slept preview (touch → resume Job). */
export const wakePreview = command(
	"unchecked",
	async (input: { name: string }): Promise<PreviewWakeResult> => {
		requireSession();
		return getApplicationAdapters().vclusterPreviews.wake(input.name);
	},
);

/**
 * Tear down a preview. E3: when the flag is on, archive run summaries +
 * un-promoted bundles FIRST (best-effort — a failure degrades to
 * `archive.archived === false` and the teardown still runs). Returns the
 * archive result so the UI can toast the archived bundle link.
 */
export const teardownPreview = command(
	"unchecked",
	async (
		input: { name: string },
	): Promise<{ archive: PreviewArchiveResult | null; preview: VclusterPreviewSummary }> => {
		const session = requireSession();
		const adapters = getApplicationAdapters();
		let archive: PreviewArchiveResult | null = null;
		if (getApplicationAdapterConfig().previewArchiveOnTeardownEnabled) {
			try {
				archive = await adapters.previewArchive.archivePreview({
					name: input.name,
					userId: session.userId,
					projectId: session.projectId ?? null,
				});
			} catch (err) {
				archive = {
					archived: false,
					preview: input.name,
					reason: err instanceof Error ? err.message : String(err),
				};
			}
		}
		const preview = await adapters.vclusterPreviews.teardown(input.name);
		return { archive, preview };
	},
);
