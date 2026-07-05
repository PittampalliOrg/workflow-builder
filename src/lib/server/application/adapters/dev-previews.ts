import type {
	VclusterPreviewGatewayPort,
	VclusterPreviewLifecycleInput,
	VclusterPreviewSleepOutcome,
	VclusterPreviewTouchResult,
	DevPreviewSidecarPort,
	DevPreviewSidecarResult,
	DevPreviewSidecarRunOutput,
	DevPreviewSidecarStatus,
} from "$lib/server/application/ports";
import type { VclusterPreviewRecord } from "$lib/types/dev-previews";
import {
	claimVclusterPreview,
	getVclusterPreview,
	listVclusterPreviewsWithCounts,
	provisionVclusterPreview,
	sleepVclusterPreview,
	teardownVclusterPreview,
	touchVclusterPreview,
	VclusterPreviewHttpError,
	type VclusterPreview,
} from "$lib/server/workflows/vcluster-preview";
import {
	allowedSidecarCommands,
	fetchSidecarStatus,
	runSidecarCommand,
} from "$lib/server/workflows/dev-preview-sidecar";

/** Legacy `VclusterPreview` → the serializable gateway record (drops the
 * job/isolation-tier plumbing the UI never reads). */
function toRecord(p: VclusterPreview): VclusterPreviewRecord {
	return {
		name: p.name,
		phase: p.phase,
		ready: p.ready,
		url: p.url,
		targetCluster: p.targetCluster,
		pool: p.pool,
		state: p.state,
		origin: p.origin,
		prNumber: p.prNumber,
		expiresAt: p.expiresAt,
		lastActive: p.lastActive,
		protected: p.protected,
		bootSeconds: p.bootSeconds,
	};
}

/** Wraps the privileged SEA vcluster-preview client. */
export class LegacyVclusterPreviewGateway implements VclusterPreviewGatewayPort {
	async listWithCounts() {
		const { previews, counts } = await listVclusterPreviewsWithCounts();
		return { previews: previews.map(toRecord), counts };
	}

	async get(name: string): Promise<VclusterPreviewRecord> {
		return toRecord(await getVclusterPreview(name));
	}

	async claim(
		input: { name: string; user?: string } & VclusterPreviewLifecycleInput,
	): Promise<VclusterPreviewRecord | null> {
		const claimed = await claimVclusterPreview(input);
		return claimed ? toRecord(claimed) : null;
	}

	async provision(
		input: { name: string } & VclusterPreviewLifecycleInput,
	): Promise<VclusterPreviewRecord> {
		return toRecord(await provisionVclusterPreview(input));
	}

	async teardown(name: string): Promise<VclusterPreviewRecord> {
		return toRecord(await teardownVclusterPreview(name));
	}

	async touch(name: string): Promise<VclusterPreviewTouchResult> {
		return touchVclusterPreview(name);
	}

	async sleep(name: string): Promise<VclusterPreviewSleepOutcome> {
		try {
			const r = await sleepVclusterPreview(name);
			return { ok: true, name: r.name, alreadySlept: r.alreadySlept };
		} catch (err) {
			if (err instanceof VclusterPreviewHttpError) {
				return { ok: false, status: err.status, detail: err.message };
			}
			throw err;
		}
	}
}

/** Wraps the dev-sync-sidecar pod control channel. */
export class LegacyDevPreviewSidecarGateway implements DevPreviewSidecarPort {
	status(input: {
		syncUrl: string | null | undefined;
	}): Promise<DevPreviewSidecarResult<DevPreviewSidecarStatus>> {
		return fetchSidecarStatus(input);
	}

	run(input: {
		syncUrl: string | null | undefined;
		service: string;
		cmd: string;
	}): Promise<DevPreviewSidecarResult<DevPreviewSidecarRunOutput>> {
		return runSidecarCommand(input);
	}

	allowedCommands(service: string): string[] {
		return allowedSidecarCommands(service);
	}
}
