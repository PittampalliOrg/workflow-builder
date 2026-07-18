/**
 * Production loader for the Dev-hub preview drift overview
 * (`getPreviewDriftOverview` in the dev route's data.remote.ts).
 *
 * Data sources (all degrade to nulls/reasons, never throw into the page):
 * - Preview list + per-preview runtime views: application adapters (cluster
 *   reads, cached 15s and deduped — one observation sweep serves every admin
 *   polling the Dev hub; the query itself stays admin-gated).
 * - Dev release pins + repo main HEADs: `github-sources` (raw fetches, 60s).
 * - Pin history (behind-pin vs diverged): exported `loadPinHistory` (10min).
 * - Promotion receipts: application surface (`vclusterPreviews.listPromotionReceipts`
 *   through the `promotion-receipts.ts` seam).
 * - Active dev sandboxes: host dev-environment groups (per-request DB read).
 */
import { getApplicationAdapters } from "$lib/server/application";
import { loadPinHistory } from "$lib/server/gitops/deployment-metadata";
import { createCachedLoader } from "$lib/server/dev-hub/cache";
import {
	buildPreviewDriftOverview,
	type RuntimeObservation,
} from "$lib/server/dev-hub/drift-logic";
import { githubSources } from "$lib/server/dev-hub/github-sources";
import { listPromotionReceiptsForPreviews } from "$lib/server/dev-hub/promotion-receipts";
import type {
	PreviewDriftOverview,
	PreviewServicePin,
	VclusterPreviewSummary,
} from "$lib/types/dev-previews";

const CLUSTER_TTL_MS = 15_000;

type ClusterSnapshot = {
	previews: VclusterPreviewSummary[];
	runtimeByPreview: Map<string, RuntimeObservation>;
};

/**
 * The 15s sweep needs an actor for the owner-or-platform-admin runtime
 * authorization; the remote query (admin-gated) records the current admin here
 * before reading, so the shared cache always observes as a real platform admin.
 */
let sweepActorUserId: string | null = null;

async function loadClusterSnapshotUncached(): Promise<ClusterSnapshot> {
	const adapters = getApplicationAdapters();
	const { previews } = await adapters.vclusterPreviews.list();
	const runtimeByPreview = new Map<string, RuntimeObservation>();
	const actorUserId = sweepActorUserId;

	await Promise.all(
		previews.map(async (preview) => {
			if (preview.state === "slept") {
				runtimeByPreview.set(preview.name, { ok: false, reason: "slept" });
				return;
			}
			if (!actorUserId) {
				runtimeByPreview.set(preview.name, {
					ok: false,
					reason: "no actor available for runtime observation",
				});
				return;
			}
			try {
				const view = await adapters.vclusterPreviews.observeRuntime({
					name: preview.name,
					actorUserId,
				});
				runtimeByPreview.set(preview.name, { ok: true, view });
			} catch (cause) {
				runtimeByPreview.set(preview.name, {
					ok: false,
					reason: cause instanceof Error ? cause.message : String(cause),
				});
			}
		}),
	);
	return { previews, runtimeByPreview };
}

const clusterSnapshot = createCachedLoader<ClusterSnapshot>({
	ttlMs: CLUSTER_TTL_MS,
	load: loadClusterSnapshotUncached,
});

export function invalidatePreviewDriftCaches(): void {
	clusterSnapshot.invalidate();
}

/** Build the drift overview. `actorUserId` MUST be a platform admin's id. */
export async function loadPreviewDriftOverview(input: {
	actorUserId: string;
	projectId: string | null;
}): Promise<PreviewDriftOverview> {
	sweepActorUserId = input.actorUserId;
	const adapters = getApplicationAdapters();

	const [snapshot, pins, pinHistory, wbHead, stacksHead] = await Promise.all([
		clusterSnapshot.get(),
		githubSources.getReleasePins(),
		loadPinHistory().catch(() => ({ imageHistory: [], error: "unavailable" })),
		githubSources.getMainHead("workflow-builder"),
		githubSources.getMainHead("stacks"),
	]);

	const [receipts, groups] = await Promise.all([
		listPromotionReceiptsForPreviews(snapshot.previews.map(({ name }) => name)),
		adapters.workflowData
			.listDevEnvironmentGroups({ projectId: input.projectId })
			.catch(() => []),
	]);

	const pinsByService = new Map<string, PreviewServicePin>(
		Object.entries(pins.services).map(([service, pin]) => [
			service,
			{ tag: pin.tag, digest: pin.digest, commitSha: pin.commitSha },
		]),
	);
	const pinHistoryByService = new Map<
		string,
		{ tags: Set<string>; digests: Set<string> }
	>();
	for (const version of pinHistory.imageHistory) {
		let entry = pinHistoryByService.get(version.service);
		if (!entry) {
			entry = { tags: new Set(), digests: new Set() };
			pinHistoryByService.set(version.service, entry);
		}
		if (version.tag) entry.tags.add(version.tag);
		if (version.digest) entry.digests.add(version.digest.toLowerCase());
	}

	return buildPreviewDriftOverview({
		previews: snapshot.previews,
		runtimeByPreview: snapshot.runtimeByPreview,
		pinsByService,
		pinHistoryByService,
		receiptsByPreview: receipts.receiptsByPreview,
		receiptExecutionIdsByPreview: receipts.executionIdsByPreview,
		activeSandboxExecutionIds: new Set(groups.map((group) => group.executionId)),
		workflowBuilderMainSha: wbHead?.sha ?? null,
		stacksMainSha: stacksHead?.sha ?? null,
	});
}
