import type {
	PreviewSleepResult,
	PreviewWakeResult,
	VclusterLaunchResult,
	VclusterPreviewCounts,
	VclusterPreviewRecord,
	VclusterPreviewSummary,
} from "$lib/types/dev-previews";
import { safePreviewName } from "$lib/types/dev-previews";
import type { VclusterPreviewGatewayPort } from "$lib/server/application/ports";

export type VclusterPreviewServiceDeps = {
	gateway: VclusterPreviewGatewayPort;
	/** Repo slug (`owner/name`) for building `prUrl` (config `prPreviewRepo`). */
	previewRepo: string;
	/** Awake-preview cap fallback when the SEA omits `counts.max` (config
	 * `vclusterPreviewMax`). SEA's own count wins when present. */
	maxPreviews: number;
};

/**
 * Application service for Tier-2 (vcluster full-isolation) previews. Owns the
 * capacity-admission policy that used to live inline in the vcluster route
 * (claim-first is never gated; the cold-provision fallback is gated on
 * `awake >= max`, with the config value as the fallback ceiling), returns a
 * full capacity refusal AS DATA, decorates records with the UI-only `prUrl`,
 * and classifies the sleep 409 into a typed reason. The privileged cluster
 * calls all go through the injected gateway port.
 */
export class ApplicationVclusterPreviewService {
	constructor(private readonly deps: VclusterPreviewServiceDeps) {}

	/** Decorate a cluster record into the UI summary (adds `prUrl`). */
	private decorate(record: VclusterPreviewRecord): VclusterPreviewSummary {
		return {
			...record,
			prUrl:
				record.prNumber != null
					? `https://github.com/${this.deps.previewRepo}/pull/${record.prNumber}`
					: null,
		};
	}

	/** List active previews + capacity counts (both decorated / passed through). */
	async list(): Promise<{
		previews: VclusterPreviewSummary[];
		counts: VclusterPreviewCounts | null;
	}> {
		const { previews, counts } = await this.deps.gateway.listWithCounts();
		return { previews: previews.map((p) => this.decorate(p)), counts };
	}

	/** Status of one preview (accepts a claimed alias). */
	async get(name: string): Promise<VclusterPreviewSummary> {
		return this.decorate(await this.deps.gateway.get(name));
	}

	/**
	 * Launch a preview: claim a warm-pool member first (instant, needs no
	 * capacity — it consumes an already-awake slot), else cold-provision behind
	 * admission control. The admission gate counts AWAKE members (which includes
	 * free pool members) against the cap; re-provisioning an existing preview of
	 * the same name is always allowed. A full cluster returns `{ok:false,
	 * reason:"capacity"}` — data, never a throw.
	 */
	async launch(input: { name: string; user?: string }): Promise<VclusterLaunchResult> {
		const name = safePreviewName(input.name);
		const claimed = await this.deps.gateway.claim({ name, user: input.user });
		if (claimed) {
			// A4: launching IS activity. A fresh claim stamps last-active atomically,
			// but an idempotent re-claim of an existing alias does not — touch covers
			// it (best-effort: a touch failure never fails the launch).
			await this.deps.gateway.touch(claimed.name).catch(() => undefined);
			return { ok: true, preview: this.decorate(claimed), pooled: true };
		}

		const { previews, counts } = await this.deps.gateway.listWithCounts();
		const cap = counts?.max && counts.max > 0 ? counts.max : this.deps.maxPreviews;
		const awake = counts?.awake ?? previews.length;
		const alreadyThis = previews.some((p) => p.name === name);
		if (!alreadyThis && awake >= cap) {
			return {
				ok: false,
				reason: "capacity",
				awake,
				max: cap,
				message: `Preview capacity reached (${awake}/${cap}). Tear one down or sleep one first.`,
			};
		}
		const preview = await this.deps.gateway.provision({ name });
		return { ok: true, preview: this.decorate(preview), pooled: false };
	}

	/**
	 * Sleep a preview. A gateway 409 is classified: "protected" when the preview
	 * carries the operator exemption, else "pool-member" (a free/recycling pool
	 * slot that stays claim-ready). Any other failure throws.
	 */
	async sleep(name: string): Promise<PreviewSleepResult> {
		const outcome = await this.deps.gateway.sleep(name);
		if (outcome.ok) {
			return { ok: true, name: outcome.name, state: "slept", alreadySlept: outcome.alreadySlept };
		}
		if (outcome.status === 409) {
			const reason = /protect/i.test(outcome.detail) ? "protected" : "pool-member";
			return { ok: false, reason, message: outcome.detail };
		}
		throw new Error(outcome.detail || `sleep failed (HTTP ${outcome.status})`);
	}

	/** Wake (resume) a slept preview by touching it — stamps last-active and, for
	 * a slept preview, starts a resume Job (`resuming: true`). */
	async wake(name: string): Promise<PreviewWakeResult> {
		const touched = await this.deps.gateway.touch(name);
		return { name: touched.name, state: touched.state, resuming: touched.resuming };
	}

	/** Tear down a preview (drops the DB + `vcluster delete`). */
	async teardown(name: string): Promise<VclusterPreviewSummary> {
		return this.decorate(await this.deps.gateway.teardown(name));
	}
}
