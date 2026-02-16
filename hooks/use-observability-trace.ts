"use client";

import useSWR from "swr";
import { api } from "@/lib/api-client";
import type { ObservabilityTraceDetails } from "@/lib/types/observability";

export function useObservabilityTrace(traceId: string | null) {
	const key = traceId ? ["observability-trace", traceId] : null;

	const { data, error, isLoading, mutate } = useSWR(
		key,
		async ([, id]: [string, string]) => api.observability.getTrace(id),
		{
			revalidateOnFocus: false,
			dedupingInterval: 3000,
		},
	);

	return {
		trace: (data?.trace ?? null) as ObservabilityTraceDetails | null,
		isLoading,
		isError: Boolean(error),
		error,
		mutate,
	};
}
