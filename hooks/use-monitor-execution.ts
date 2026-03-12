import { useEffect, useState } from "react";
import useSWR from "swr";
import type { WorkflowDetail } from "@/lib/types/workflow-ui";

const fetcher = async (url: string) => {
	const res = await fetch(url);
	const data = await res.json();
	if (!res.ok) {
		const message =
			typeof data?.error === "string"
				? data.error
				: `Request failed: ${res.status}`;
		throw new Error(message);
	}
	return data;
};

/**
 * Hook to fetch a single workflow execution detail
 * Polls every 3 seconds for real-time updates if workflow is running
 */
export function useMonitorExecution(instanceId: string | null) {
	const url = instanceId ? `/api/monitor/${instanceId}` : null;
	const [streamAvailable, setStreamAvailable] = useState(false);
	const [streamAttempted, setStreamAttempted] = useState(false);

	const { data, error, isLoading, mutate } = useSWR<WorkflowDetail>(
		url,
		fetcher,
		{
			refreshInterval: (data) => {
				const isActive =
					data?.status === "RUNNING" ||
					data?.status === "PENDING" ||
					data?.status === "SUSPENDED";
				if (!data) return 3000;
				if (!isActive) return 0;
				return streamAvailable ? 0 : 3000;
			},
			revalidateOnFocus: true,
			dedupingInterval: 1000,
		},
	);

	useEffect(() => {
		if (!instanceId || typeof window === "undefined") {
			return;
		}
		const isActive =
			data?.status === "RUNNING" ||
			data?.status === "PENDING" ||
			data?.status === "SUSPENDED";
		if (!isActive) {
			setStreamAvailable(false);
			return;
		}

		setStreamAttempted(true);
		const source = new EventSource(`/api/monitor/${instanceId}/events`);
		source.addEventListener("ready", () => {
			setStreamAvailable(true);
		});
		source.addEventListener("workflow", (event) => {
			setStreamAvailable(true);
			const payload = JSON.parse(
				(event as MessageEvent).data,
			) as WorkflowDetail;
			void mutate(payload, false);
		});
		source.addEventListener("complete", () => {
			setStreamAvailable(true);
			void mutate();
			source.close();
		});
		source.addEventListener("error", () => {
			setStreamAvailable(false);
			source.close();
		});

		return () => {
			source.close();
		};
	}, [data?.status, instanceId, mutate]);

	return {
		execution: data,
		isLoading,
		isError: error,
		mutate,
		streamAvailable: streamAttempted && streamAvailable,
	};
}
