import useSWR from "swr";
import type { WorkflowDetail } from "@/lib/types/workflow-ui";

const fetcher = async (url: string) => {
  const res = await fetch(url);
  const data = await res.json();
  if (!res.ok) {
    const message =
      typeof data?.error === "string" ? data.error : `Request failed: ${res.status}`;
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

  const { data, error, isLoading, mutate } = useSWR<WorkflowDetail>(
    url,
    fetcher,
    {
      // Poll every 3 seconds if workflow is running
      refreshInterval: (data) => {
        if (!data) {
          return 3000;
        }
        return data.status === "RUNNING" ? 3000 : 0;
      },
      revalidateOnFocus: true,
      dedupingInterval: 1000,
    }
  );

  return {
    execution: data,
    isLoading,
    isError: error,
    mutate,
  };
}
