"use client";

import useSWR from "swr";
import { api } from "@/lib/api-client";
import type { ObservabilityTraceDetails } from "@/lib/types/observability";

type UseObservabilityTraceOptions = {
	executionId?: string | null;
};

export function useObservabilityTrace(
	traceId: string | null,
	options?: UseObservabilityTraceOptions,
) {
	const executionId = options?.executionId ?? null;
	const key = traceId ? ["observability-trace", traceId, executionId] : null;

	const { data, error, isLoading, mutate } = useSWR(
		key,
		async ([, id, resolvedExecutionId]: [string, string, string | null]) =>
			api.observability.getTrace(id, {
				executionId: resolvedExecutionId,
			}),
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
