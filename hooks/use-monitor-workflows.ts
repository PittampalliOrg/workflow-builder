import useSWR from "swr";
import type { WorkflowListItem, WorkflowUIStatus, WorkflowDetail } from "@/lib/types/workflow-ui";

interface MonitorWorkflowsResponse {
  workflows: WorkflowListItem[];
  total: number;
  limit: number;
  offset: number;
}

interface UseMonitorWorkflowsOptions {
  search?: string;
  status?: WorkflowUIStatus[];
  limit?: number;
  offset?: number;
  refreshInterval?: number;
}

const fetcher = (url: string) => fetch(url).then((res) => res.json());

/**
 * Hook to fetch workflow executions with optional filtering
 * Polls every 3 seconds by default for real-time updates
 */
export function useMonitorWorkflows(options: UseMonitorWorkflowsOptions = {}) {
  const {
    search,
    status,
    limit = 50,
    offset = 0,
    refreshInterval = 3000,
  } = options;

  // Build query parameters
  const params = new URLSearchParams();
  if (search) params.set("search", search);
  if (status && status.length > 0) params.set("status", status.join(","));
  params.set("limit", limit.toString());
  params.set("offset", offset.toString());

  const url = `/api/monitor?${params.toString()}`;

  const { data, error, isLoading, mutate } = useSWR<MonitorWorkflowsResponse>(
    url,
    fetcher,
    {
      refreshInterval,
      revalidateOnFocus: true,
      dedupingInterval: 1000,
    }
  );

  return {
    workflows: data?.workflows || [],
    total: data?.total || 0,
    isLoading,
    isError: error,
    mutate,
  };
}

/**
 * Hook to fetch a single workflow detail by instance ID
 * This is a compatibility wrapper matching the ai-chatbot API shape
 *
 * @param appId - App ID (ignored in workflow-builder, kept for compatibility)
 * @param instanceId - The workflow execution ID
 * @param refreshInterval - Polling interval in ms (0 to disable)
 */
export function useDaprWorkflow(
  appId: string,
  instanceId: string,
  refreshInterval: number = 3000
) {
  const url = instanceId ? `/api/monitor/${instanceId}` : null;

  const { data, error, isLoading, mutate } = useSWR<WorkflowDetail>(
    url,
    fetcher,
    {
      refreshInterval: refreshInterval > 0 ? refreshInterval : undefined,
      revalidateOnFocus: true,
      dedupingInterval: 1000,
    }
  );

  return {
    workflow: data,
    isLoading,
    isError: !!error,
    error,
    mutate,
  };
}
