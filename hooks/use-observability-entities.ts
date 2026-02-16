"use client";

import useSWR from "swr";
import { api } from "@/lib/api-client";
import type { ObservabilityEntityOption } from "@/lib/types/observability";

export function useObservabilityEntities() {
	const { data, error, isLoading, mutate } = useSWR(
		"observability-entities",
		() => api.observability.getEntities(),
		{
			revalidateOnFocus: true,
			dedupingInterval: 5000,
		},
	);

	return {
		entities: (data?.entities ?? []) as ObservabilityEntityOption[],
		isLoading,
		isError: Boolean(error),
		error,
		mutate,
	};
}
