import type { VclusterPreviewGatewayPort } from '$lib/server/application/ports';
import type {
	ApplicationPreviewArchiveService,
	PreviewArchiveResult
} from '$lib/server/application/preview-archive';
import type { VclusterPreviewRecord } from '$lib/types/dev-previews';

const FULL_SHA = /^[0-9a-f]{40}$/;

export type PreviewLifecycleReapItem = Readonly<{
	name: string;
	status:
		| 'teardown-started'
		| 'archive-refused'
		| 'wake-timeout'
		| 'invalid-owner'
		| 'teardown-failed';
	archive: PreviewArchiveResult | null;
	detail?: string;
}>;

export type PreviewLifecycleReapResult = Readonly<{
	expired: number;
	processed: number;
	teardownStarted: number;
	teardownFailed: number;
	archiveRefused: number;
	items: readonly PreviewLifecycleReapItem[];
}>;

type PreviewLifecycleReaperDeps = Readonly<{
	previews: Pick<VclusterPreviewGatewayPort, 'listWithCounts' | 'get' | 'touch' | 'teardown'>;
	archive: Pick<ApplicationPreviewArchiveService, 'archivePreview'>;
	now?: () => Date;
	sleep?: (milliseconds: number) => Promise<void>;
	batchSize?: number;
	wakeTimeoutMs?: number;
}>;

/**
 * Archives mutable preview state before TTL teardown. SEA may sleep these
 * previews for capacity, but only this application service may delete them.
 */
export class ApplicationPreviewLifecycleReaperService {
	constructor(private readonly deps: PreviewLifecycleReaperDeps) {}

	async reapExpired(): Promise<PreviewLifecycleReapResult> {
		const now = (this.deps.now?.() ?? new Date()).getTime();
		const { previews } = await this.deps.previews.listWithCounts();
		const expired = previews
			.filter((preview) => this.isExpiredManagedPreview(preview, now))
			.sort((left, right) => String(left.expiresAt).localeCompare(String(right.expiresAt)));
		const items: PreviewLifecycleReapItem[] = [];
		for (const candidate of expired.slice(0, this.batchSize())) {
			if (!this.requiresArchive(candidate)) {
				const requestId =
					typeof candidate.provenance?.requestId === 'string' ? candidate.provenance.requestId : '';
				if (!requestId || !FULL_SHA.test(candidate.sourceRevision ?? '')) {
					items.push({
						name: candidate.name,
						status: 'invalid-owner',
						archive: null,
						detail: 'teardown ownership tuple is incomplete'
					});
					continue;
				}
				try {
					await this.deps.previews.teardown(candidate.name, {
						mode: 'owned',
						requestId,
						sourceRevision: candidate.sourceRevision as string
					});
				} catch (cause) {
					items.push({
						name: candidate.name,
						status: 'teardown-failed',
						archive: null,
						detail: cause instanceof Error ? cause.message : String(cause)
					});
					continue;
				}
				items.push({
					name: candidate.name,
					status: 'teardown-started',
					archive: null
				});
				continue;
			}
			const ownerId = candidate.owner?.id?.trim() ?? '';
			if (!ownerId) {
				items.push({
					name: candidate.name,
					status: 'invalid-owner',
					archive: null
				});
				continue;
			}
			const ready = candidate.ready ? candidate : await this.wakeAndWait(candidate.name);
			if (!ready) {
				items.push({
					name: candidate.name,
					status: 'wake-timeout',
					archive: null
				});
				continue;
			}
			let archive: PreviewArchiveResult;
			try {
				archive = await this.deps.archive.archivePreview({
					name: ready.name,
					userId: ownerId,
					projectId: null
				});
			} catch (cause) {
				items.push({
					name: ready.name,
					status: 'archive-refused',
					archive: null,
					detail: cause instanceof Error ? cause.message : String(cause)
				});
				continue;
			}
			if (!archive.archived) {
				items.push({
					name: ready.name,
					status: 'archive-refused',
					archive,
					detail: archive.reason
				});
				continue;
			}
			const requestId =
				typeof ready.provenance?.requestId === 'string' ? ready.provenance.requestId : '';
			if (!requestId || !FULL_SHA.test(ready.sourceRevision ?? '')) {
				items.push({
					name: ready.name,
					status: 'archive-refused',
					archive,
					detail: 'teardown ownership tuple is incomplete'
				});
				continue;
			}
			try {
				await this.deps.previews.teardown(ready.name, {
					mode: 'owned',
					requestId,
					sourceRevision: ready.sourceRevision as string,
					archiveConfirmed: true
				});
			} catch (cause) {
				items.push({
					name: ready.name,
					status: 'teardown-failed',
					archive,
					detail: cause instanceof Error ? cause.message : String(cause)
				});
				continue;
			}
			items.push({
				name: ready.name,
				status: 'teardown-started',
				archive
			});
		}

		return Object.freeze({
			expired: expired.length,
			processed: items.length,
			teardownStarted: items.filter((item) => item.status === 'teardown-started').length,
			teardownFailed: items.filter((item) => item.status === 'teardown-failed').length,
			archiveRefused: items.filter((item) => item.status === 'archive-refused').length,
			items: Object.freeze(items)
		});
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

	private async wakeAndWait(name: string): Promise<VclusterPreviewRecord | null> {
		await this.deps.previews.touch(name);
		const deadline = Date.now() + (this.deps.wakeTimeoutMs ?? 120_000);
		const sleep =
			this.deps.sleep ??
			((milliseconds: number) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds)));
		while (Date.now() < deadline) {
			const preview = await this.deps.previews.get(name);
			if (preview.ready) return preview;
			await sleep(2_000);
		}
		return null;
	}

	private batchSize(): number {
		return Math.max(1, Math.min(10, this.deps.batchSize ?? 3));
	}
}
