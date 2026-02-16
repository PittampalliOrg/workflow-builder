"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api } from "@/lib/api-client";
import type {
	ObservabilityTraceFilters,
	ObservabilityTraceSummary,
} from "@/lib/types/observability";

type UseObservabilityTracesOptions = {
	filters?: ObservabilityTraceFilters;
	autoLoad?: boolean;
};

function mergeUniqueTraces(
	existing: ObservabilityTraceSummary[],
	next: ObservabilityTraceSummary[],
): ObservabilityTraceSummary[] {
	const byTraceId = new Map<string, ObservabilityTraceSummary>();

	for (const trace of existing) {
		byTraceId.set(trace.traceId, trace);
	}

	for (const trace of next) {
		byTraceId.set(trace.traceId, trace);
	}

	return Array.from(byTraceId.values()).sort(
		(a, b) => new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime(),
	);
}

export function useObservabilityTraces(
	options: UseObservabilityTracesOptions = {},
) {
	const { filters, autoLoad = true } = options;

	const normalizedFilters = useMemo(
		() => ({
			entityType: filters?.entityType,
			entityId: filters?.entityId,
			from: filters?.from,
			to: filters?.to,
			search: filters?.search,
			limit: filters?.limit ?? 25,
		}),
		[
			filters?.entityType,
			filters?.entityId,
			filters?.from,
			filters?.to,
			filters?.search,
			filters?.limit,
		],
	);

	const requestIdRef = useRef(0);
	const [traces, setTraces] = useState<ObservabilityTraceSummary[]>([]);
	const [nextCursor, setNextCursor] = useState<string | null>(null);
	const [isLoading, setIsLoading] = useState(false);
	const [isLoadingMore, setIsLoadingMore] = useState(false);
	const [error, setError] = useState<Error | null>(null);

	const fetchPage = useCallback(
		async (cursor: string | null, append: boolean) => {
			const requestId = ++requestIdRef.current;

			if (append) {
				setIsLoadingMore(true);
			} else {
				setIsLoading(true);
			}

			try {
				const response = await api.observability.getTraces({
					...normalizedFilters,
					cursor: cursor ?? undefined,
				});

				if (requestIdRef.current !== requestId) {
					return;
				}

				setTraces((previous) =>
					append
						? mergeUniqueTraces(previous, response.traces)
						: response.traces,
				);
				setNextCursor(response.nextCursor);
				setError(null);
			} catch (err) {
				if (requestIdRef.current !== requestId) {
					return;
				}
				setError(
					err instanceof Error ? err : new Error("Failed to load traces"),
				);
			} finally {
				if (requestIdRef.current === requestId) {
					setIsLoading(false);
					setIsLoadingMore(false);
				}
			}
		},
		[normalizedFilters],
	);

	useEffect(() => {
		if (!autoLoad) {
			return;
		}
		fetchPage(null, false);
	}, [autoLoad, fetchPage]);

	const refresh = useCallback(async () => {
		await fetchPage(null, false);
	}, [fetchPage]);

	const loadMore = useCallback(async () => {
		if (!nextCursor || isLoadingMore) {
			return;
		}
		await fetchPage(nextCursor, true);
	}, [fetchPage, isLoadingMore, nextCursor]);

	return {
		traces,
		nextCursor,
		hasNextPage: Boolean(nextCursor),
		isLoading,
		isLoadingMore,
		isError: Boolean(error),
		error,
		refresh,
		loadMore,
	};
}
