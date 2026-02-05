import useSWR from "swr";
import type { WorkflowNameStats } from "@/lib/types/workflow-ui";

interface MonitorByNameResponse {
  stats: WorkflowNameStats[];
  total: number;
}

const fetcher = (url: string) => fetch(url).then((res) => res.json());

/**
 * Hook to fetch workflow name aggregations
 * Shows statistics grouped by workflow name
 */
export function useMonitorByName(refreshInterval = 5000) {
  const { data, error, isLoading, mutate } = useSWR<MonitorByNameResponse>(
    "/api/monitor/names",
    fetcher,
    {
      refreshInterval,
      revalidateOnFocus: true,
      dedupingInterval: 2000,
    }
  );

  return {
    stats: data?.stats || [],
    total: data?.total || 0,
    isLoading,
    isError: !!error,
    error,
    mutate,
  };
}
