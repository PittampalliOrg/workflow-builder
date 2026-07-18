/**
 * Pure derivation logic for the sync-generation timeline on the dev execution
 * detail surface. The inputs are the execution's code-version artifacts (the
 * same `/api/workflows/executions/{id}/versions` read the checkpoints panel
 * performs); this module keeps the timeline computable and unit-testable
 * without rendering.
 */

/** Structural subset of the versions-endpoint record the timeline consumes. */
export type SyncTimelineVersionInput = {
	artifactId: string;
	createdAt: string;
	payload?: {
		tier?: string;
		iteration?: number | null;
		services?: string[] | null;
		serviceCount?: number | null;
		generation?: string | null;
		captureProtocol?: string | null;
	} | null;
	promotion?: {
		prUrl?: string | null;
		promotedAt?: string;
		commitSha?: string | null;
		repository?: string | null;
		pullRequestNumber?: number | null;
		pullRequest?: { repository?: string | null; number?: number | null } | null;
	} | null;
	acceptance?: { ok?: boolean; acceptedAt?: string | null } | null;
};

/** One generation on the timeline (a capture, optionally promoted/accepted). */
export type SyncGenerationTimelineEntry = {
	artifactId: string;
	/** Full live-sync generation id (`payload.generation`). */
	generation: string;
	/** Short display form of the generation id. */
	shortGeneration: string;
	createdAt: string;
	/** Services touched by this generation's capture. */
	services: string[];
	serviceCount: number;
	/** True for atomic-generation-v2 strict captures. */
	strict: boolean;
	iteration: number | null;
	/** Promote marker: the capture is represented by a GitHub PR. */
	promoted: boolean;
	prUrl: string | null;
	/** Acceptance marker: true passed, false failed, null not run/unknown. */
	accepted: boolean | null;
};

export const ATOMIC_GENERATION_PROTOCOL = 'atomic-generation-v2';

function pullRequestUrl(
	receipt: { repository?: string | null; number?: number | null } | null | undefined
): string | null {
	const repository = receipt?.repository?.trim();
	const number = receipt?.number;
	if (!repository || typeof number !== 'number' || !Number.isSafeInteger(number) || number < 1) {
		return null;
	}
	return `https://github.com/${repository}/pull/${number}`;
}

function promotionPrUrl(version: SyncTimelineVersionInput): string | null {
	const stored = version.promotion?.prUrl?.trim();
	if (stored) return stored;
	return pullRequestUrl(
		version.promotion?.pullRequest ?? {
			repository: version.promotion?.repository,
			number: version.promotion?.pullRequestNumber
		}
	);
}

export function shortGeneration(generation: string): string {
	return generation.length <= 10 ? generation : generation.slice(0, 10);
}

/**
 * Generation-bearing captures, newest first. Versions without a
 * `payload.generation` (legacy bundles) carry no live-sync generation and are
 * excluded — the checkpoints panel still lists them.
 */
export function buildSyncGenerationTimeline(
	versions: SyncTimelineVersionInput[]
): SyncGenerationTimelineEntry[] {
	const entries: SyncGenerationTimelineEntry[] = [];
	for (const version of versions) {
		const generation = version.payload?.generation?.trim();
		if (!generation) continue;
		const createdMs = Date.parse(version.createdAt);
		if (Number.isNaN(createdMs)) continue;
		const services = (version.payload?.services ?? []).filter(
			(service): service is string => typeof service === 'string' && service.length > 0
		);
		const prUrl = promotionPrUrl(version);
		entries.push({
			artifactId: version.artifactId,
			generation,
			shortGeneration: shortGeneration(generation),
			createdAt: version.createdAt,
			services,
			serviceCount: version.payload?.serviceCount ?? services.length,
			strict: version.payload?.captureProtocol === ATOMIC_GENERATION_PROTOCOL,
			iteration: version.payload?.iteration ?? null,
			promoted: prUrl !== null,
			prUrl,
			accepted: typeof version.acceptance?.ok === 'boolean' ? version.acceptance.ok : null
		});
	}
	return entries.sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
}

/** One bucket of the capture-cadence sparkline. */
export type SyncCadencePoint = { ts: Date; count: number };

/**
 * Bucketed capture counts across the run so a sparkline can show sync cadence.
 * Returns [] when there are fewer than three captures or no time span (a
 * sparkline would be noise).
 */
export function buildSyncCadenceSeries(
	entries: Pick<SyncGenerationTimelineEntry, 'createdAt'>[],
	bucketCount = 16
): SyncCadencePoint[] {
	const times = entries
		.map((entry) => Date.parse(entry.createdAt))
		.filter((t) => !Number.isNaN(t))
		.sort((a, b) => a - b);
	if (times.length < 3) return [];
	const first = times[0];
	const last = times[times.length - 1];
	const span = last - first;
	if (span <= 0) return [];
	const buckets = Math.max(2, Math.min(bucketCount, times.length * 2));
	const bucketMs = span / buckets;
	const points: SyncCadencePoint[] = Array.from({ length: buckets }, (_, i) => ({
		ts: new Date(first + bucketMs * (i + 0.5)),
		count: 0
	}));
	for (const t of times) {
		const index = Math.min(buckets - 1, Math.floor((t - first) / bucketMs));
		points[index].count += 1;
	}
	return points;
}

/** Human summary of the cadence window, e.g. "12 captures over 34m". */
export function describeSyncCadence(
	entries: Pick<SyncGenerationTimelineEntry, 'createdAt'>[]
): string | null {
	const times = entries
		.map((entry) => Date.parse(entry.createdAt))
		.filter((t) => !Number.isNaN(t))
		.sort((a, b) => a - b);
	if (times.length < 2) return null;
	const spanMs = times[times.length - 1] - times[0];
	if (spanMs <= 0) return null;
	const spanLabel =
		spanMs < 60_000
			? `${Math.max(1, Math.round(spanMs / 1000))}s`
			: spanMs < 3_600_000
				? `${Math.round(spanMs / 60_000)}m`
				: `${(spanMs / 3_600_000).toFixed(1)}h`;
	return `${times.length} captures over ${spanLabel}`;
}
