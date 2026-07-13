import type {
	PreviewArchivePort,
	PreviewArchiveResult,
	PreviewDeploymentScopePort,
	VclusterPreviewGatewayPort
} from '$lib/server/application/ports';
import type { VclusterPreviewRecord } from '$lib/types/dev-previews';
import { PreviewDeploymentScopeDeniedError } from '$lib/server/application/preview-deployment-scope';

const FULL_SHA = /^[0-9a-f]{40}$/;
const DEFAULT_ARCHIVE_RETRY_GRACE_MS = 60 * 60_000;
const DEFAULT_FAIRNESS_WINDOW_MS = 60_000;
const DEFAULT_WAKE_POLL_MS = 2_000;

export type PreviewLifecycleReapItem = Readonly<{
	name: string;
	status:
		| 'teardown-started'
		| 'archive-retry'
		| 'wake-retry'
		| 'invalid-owner'
		| 'teardown-failed'
		| 'quarantine-teardown-started'
		| 'quarantine-teardown-failed';
	archive: PreviewArchiveResult | null;
	detail?: string;
	forced?: boolean;
	graceExpiredAt?: string;
}>;

export type PreviewLifecycleReapResult = Readonly<{
	expired: number;
	processed: number;
	teardownStarted: number;
	teardownFailed: number;
	archiveRefused: number;
	retryDeferred: number;
	quarantineTeardownStarted: number;
	items: readonly PreviewLifecycleReapItem[];
}>;

type PreviewLifecycleReaperDeps = Readonly<{
	previews: Pick<VclusterPreviewGatewayPort, 'listWithCounts' | 'get' | 'touch' | 'teardown'>;
	archive: Pick<PreviewArchivePort, 'archivePreview' | 'quarantinePreview'>;
	scope: Pick<PreviewDeploymentScopePort, 'isControlPlane'>;
	now?: () => Date;
	sleep?: (milliseconds: number) => Promise<void>;
	batchSize?: number;
	wakeTimeoutMs?: number;
	wakePollMs?: number;
	archiveRetryGraceMs?: number;
	fairnessWindowMs?: number;
}>;

type OwnedGuard = Readonly<{
	mode: 'owned';
	requestId: string;
	sourceRevision: string;
}>;

type WakeResult =
	| Readonly<{ preview: VclusterPreviewRecord; detail: null }>
	| Readonly<{ preview: null; detail: string }>;

/**
 * Archives mutable preview state before TTL teardown. SEA may sleep these
 * previews for capacity, but only this application service may delete them.
 */
export class ApplicationPreviewLifecycleReaperService {
	constructor(private readonly deps: PreviewLifecycleReaperDeps) {}

	async reapExpired(): Promise<PreviewLifecycleReapResult> {
		if (!this.deps.scope.isControlPlane()) {
			throw new PreviewDeploymentScopeDeniedError(
				'preview lifecycle reaping is unavailable from a preview deployment'
			);
		}
		const nowDate = this.deps.now?.() ?? new Date();
		const now = nowDate.getTime();
		const { previews } = await this.deps.previews.listWithCounts();
		const expired = previews
			.filter((preview) => this.isExpiredManagedPreview(preview, now))
			.sort((left, right) => this.compareExpired(left, right));
		const candidates = this.selectFairBatch(expired, now);
		const items: PreviewLifecycleReapItem[] = [];
		for (const candidate of candidates) {
			const guard = this.ownedGuard(candidate);
			if (!guard) {
				items.push({
					name: candidate.name,
					status: 'invalid-owner',
					archive: null,
					detail: 'teardown ownership tuple is incomplete'
				});
				continue;
			}

			if (!this.requiresArchive(candidate)) {
				items.push(await this.teardown(candidate.name, guard, null));
				continue;
			}

			const ownerId = candidate.owner?.id?.trim() ?? '';
			if (!ownerId) {
				items.push({
					name: candidate.name,
					status: 'invalid-owner',
					archive: null,
					detail: 'archive owner is missing'
				});
				continue;
			}

			const graceExpiredAtMs = this.graceExpiredAt(candidate);
			const graceExpiredAt = new Date(graceExpiredAtMs).toISOString();
			const forceAllowed = now >= graceExpiredAtMs;
			const wake = candidate.ready
				? ({ preview: candidate, detail: null } as const)
				: await this.wakeAndWait(candidate.name);
			if (!wake.preview) {
				if (!forceAllowed) {
					items.push({
						name: candidate.name,
						status: 'wake-retry',
						archive: null,
						detail: wake.detail,
						graceExpiredAt
					});
					continue;
				}
				items.push(
					await this.forceQuarantineTeardown({
						candidate,
						ownerId,
						guard,
						attemptedArchive: null,
						reason: `wake-unavailable:${wake.detail}`,
						forcedAt: nowDate.toISOString(),
						graceExpiredAt
					})
				);
				continue;
			}

			if (!this.sameOwnership(candidate, wake.preview)) {
				items.push({
					name: candidate.name,
					status: 'invalid-owner',
					archive: null,
					detail: 'preview ownership changed while waking'
				});
				continue;
			}

			let archive: PreviewArchiveResult | null = null;
			let archiveFailure = '';
			try {
				archive = await this.deps.archive.archivePreview({
					name: wake.preview.name,
					userId: ownerId,
					projectId: null
				});
				if (!archive.archived) archiveFailure = archive.reason ?? 'archive-incomplete';
			} catch (cause) {
				archiveFailure = `archive-error:${this.errorDetail(cause)}`;
			}

			if (archive?.archived) {
				items.push(
					await this.teardown(wake.preview.name, { ...guard, archiveConfirmed: true }, archive)
				);
				continue;
			}

			if (!forceAllowed) {
				items.push({
					name: wake.preview.name,
					status: 'archive-retry',
					archive,
					detail: archiveFailure,
					graceExpiredAt
				});
				continue;
			}
			items.push(
				await this.forceQuarantineTeardown({
					candidate: wake.preview,
					ownerId,
					guard,
					attemptedArchive: archive,
					reason: archiveFailure || 'archive-incomplete',
					forcedAt: nowDate.toISOString(),
					graceExpiredAt
				})
			);
		}

		const teardownStarted = items.filter((item) =>
			['teardown-started', 'quarantine-teardown-started'].includes(item.status)
		).length;
		const teardownFailed = items.filter((item) =>
			['teardown-failed', 'quarantine-teardown-failed'].includes(item.status)
		).length;
		const retryDeferred = items.filter((item) =>
			['archive-retry', 'wake-retry'].includes(item.status)
		).length;
		return Object.freeze({
			expired: expired.length,
			processed: items.length,
			teardownStarted,
			teardownFailed,
			archiveRefused: retryDeferred,
			retryDeferred,
			quarantineTeardownStarted: items.filter(
				(item) => item.status === 'quarantine-teardown-started'
			).length,
			items: Object.freeze(items)
		});
	}

	private async teardown(
		name: string,
		guard: Parameters<VclusterPreviewGatewayPort['teardown']>[1],
		archive: PreviewArchiveResult | null
	): Promise<PreviewLifecycleReapItem> {
		try {
			await this.deps.previews.teardown(name, guard);
			return { name, status: 'teardown-started', archive };
		} catch (cause) {
			return {
				name,
				status: 'teardown-failed',
				archive,
				detail: this.errorDetail(cause)
			};
		}
	}

	private async forceQuarantineTeardown(
		input: Readonly<{
			candidate: VclusterPreviewRecord;
			ownerId: string;
			guard: OwnedGuard;
			attemptedArchive: PreviewArchiveResult | null;
			reason: string;
			forcedAt: string;
			graceExpiredAt: string;
		}>
	): Promise<PreviewLifecycleReapItem> {
		const reason = this.boundReason(input.reason);
		let archive = input.attemptedArchive;
		let markerFailure = '';
		try {
			archive = await this.deps.archive.quarantinePreview({
				preview: {
					name: input.candidate.name,
					pool: input.candidate.pool,
					url: input.candidate.url,
					expiresAt: input.candidate.expiresAt as string
				},
				userId: input.ownerId,
				projectId: null,
				reason,
				forcedAt: input.forcedAt,
				graceExpiredAt: input.graceExpiredAt,
				attemptedArchive: input.attemptedArchive
			});
		} catch (cause) {
			markerFailure = `quarantine marker failed: ${this.errorDetail(cause)}`;
		}

		try {
			await this.deps.previews.teardown(input.candidate.name, {
				...input.guard,
				archiveConfirmed: true,
				archiveQuarantine: {
					forcedAt: input.forcedAt,
					graceExpiredAt: input.graceExpiredAt,
					reason,
					...(archive?.summaryFileId ? { summaryFileId: archive.summaryFileId } : {})
				}
			});
			return {
				name: input.candidate.name,
				status: 'quarantine-teardown-started',
				archive,
				forced: true,
				graceExpiredAt: input.graceExpiredAt,
				detail: markerFailure || `forced after archive grace: ${reason}`
			};
		} catch (cause) {
			return {
				name: input.candidate.name,
				status: 'quarantine-teardown-failed',
				archive,
				forced: true,
				graceExpiredAt: input.graceExpiredAt,
				detail: [markerFailure, this.errorDetail(cause)].filter(Boolean).join('; ')
			};
		}
	}

	private isExpiredManagedPreview(preview: VclusterPreviewRecord, now: number): boolean {
		if (
			preview.protected ||
			!['ephemeral', 'retained'].includes(preview.lifecycle ?? '') ||
			!['app-live', 'manifest-candidate'].includes(preview.profile ?? '') ||
			!['live', 'reconciled'].includes(preview.mode ?? '') ||
			preview.trustedCode !== true ||
			preview.pool !== null ||
			!preview.expiresAt
		) {
			return false;
		}
		const expiresAt = new Date(preview.expiresAt).getTime();
		return Number.isFinite(expiresAt) && expiresAt <= now;
	}

	private requiresArchive(preview: VclusterPreviewRecord): boolean {
		return preview.profile === 'app-live' && preview.mode === 'live';
	}

	private ownedGuard(preview: VclusterPreviewRecord): OwnedGuard | null {
		const requestId =
			typeof preview.provenance?.requestId === 'string' ? preview.provenance.requestId : '';
		if (!requestId || !FULL_SHA.test(preview.sourceRevision ?? '')) return null;
		return {
			mode: 'owned',
			requestId,
			sourceRevision: preview.sourceRevision as string
		};
	}

	private sameOwnership(left: VclusterPreviewRecord, right: VclusterPreviewRecord): boolean {
		return (
			left.name === right.name &&
			left.owner?.kind === right.owner?.kind &&
			left.owner?.id === right.owner?.id &&
			left.provenance?.requestId === right.provenance?.requestId &&
			left.sourceRevision === right.sourceRevision
		);
	}

	private async wakeAndWait(name: string): Promise<WakeResult> {
		try {
			await this.deps.previews.touch(name);
		} catch (cause) {
			return {
				preview: null,
				detail: `wake request failed: ${this.errorDetail(cause)}`
			};
		}
		const pollMs = Math.max(1, this.deps.wakePollMs ?? DEFAULT_WAKE_POLL_MS);
		const attempts = Math.max(1, Math.ceil((this.deps.wakeTimeoutMs ?? 120_000) / pollMs));
		const sleep =
			this.deps.sleep ??
			((milliseconds: number) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds)));
		let lastReadFailure = '';
		for (let attempt = 0; attempt < attempts; attempt += 1) {
			try {
				const preview = await this.deps.previews.get(name);
				if (preview.ready) return { preview, detail: null };
			} catch (cause) {
				lastReadFailure = this.errorDetail(cause);
			}
			if (attempt + 1 < attempts) await sleep(pollMs);
		}
		return {
			preview: null,
			detail: lastReadFailure ? `wake status failed: ${lastReadFailure}` : 'wake timed out'
		};
	}

	private compareExpired(left: VclusterPreviewRecord, right: VclusterPreviewRecord): number {
		return (
			String(left.expiresAt).localeCompare(String(right.expiresAt)) ||
			left.name.localeCompare(right.name)
		);
	}

	private selectFairBatch(
		expired: readonly VclusterPreviewRecord[],
		now: number
	): readonly VclusterPreviewRecord[] {
		if (expired.length <= this.batchSize()) return expired;
		const oldestExpiry = new Date(expired[0].expiresAt as string).getTime();
		const windowMs = Math.max(1, this.deps.fairnessWindowMs ?? DEFAULT_FAIRNESS_WINDOW_MS);
		const elapsedSlots = Math.floor(Math.max(0, now - oldestExpiry) / windowMs);
		const offset = elapsedSlots % expired.length;
		const rotated = [...expired.slice(offset), ...expired.slice(0, offset)];
		return rotated.slice(0, this.batchSize());
	}

	private graceExpiredAt(preview: VclusterPreviewRecord): number {
		return (
			new Date(preview.expiresAt as string).getTime() +
			Math.max(0, this.deps.archiveRetryGraceMs ?? DEFAULT_ARCHIVE_RETRY_GRACE_MS)
		);
	}

	private batchSize(): number {
		return Math.max(1, Math.min(10, this.deps.batchSize ?? 3));
	}

	private errorDetail(cause: unknown): string {
		return cause instanceof Error ? cause.message : String(cause);
	}

	private boundReason(reason: string): string {
		const normalized = reason.trim().replace(/\s+/g, ' ');
		return (normalized || 'archive-incomplete').slice(0, 240);
	}
}
