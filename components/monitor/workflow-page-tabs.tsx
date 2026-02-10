"use client";

/**
 * WorkflowPageTabs Component
 *
 * Main tabs wrapper for the workflows page with two tabs:
 * - "Workflow names" - Aggregated view showing workflow types with execution stats
 * - "All workflow executions" - Existing executions table
 */

import { RefreshCw, Search, X } from "lucide-react";
import { useRouter, useSearchParams } from "next/navigation";
import { useCallback, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useMonitorByName } from "@/hooks/use-monitor-by-name";
import { useMonitorWorkflows } from "@/hooks/use-monitor-workflows";
import type { WorkflowFilters } from "@/lib/types/workflow-ui";
import { DaprWorkflowTable } from "./dapr-workflow-table";
import { WorkflowFilters as WorkflowFiltersComponent } from "./workflow-filters";
import { WorkflowNamesTable } from "./workflow-names-table";

// ============================================================================
// Types
// ============================================================================

type TabValue = "names" | "executions";

// ============================================================================
// Component
// ============================================================================

export function WorkflowPageTabs() {
  const router = useRouter();
  const searchParams = useSearchParams();

  // Tab state from URL or default to "names"
  const initialTab = (searchParams.get("tab") as TabValue) || "names";
  const [activeTab, setActiveTab] = useState<TabValue>(initialTab);

  // Filters for workflow names tab
  const [namesSearch, setNamesSearch] = useState("");

  // Filters for executions tab
  const [executionsFilters, setExecutionsFilters] = useState<WorkflowFilters>({
    search: searchParams.get("name") || undefined,
  });

  // Data hooks
  const {
    stats: workflowNames,
    total: namesTotal,
    isLoading: namesLoading,
    isError: namesError,
    error: namesErrorObj,
    mutate: mutateNames,
  } = useMonitorByName();

  const {
    workflows,
    total: executionsTotal,
    isLoading: executionsLoading,
    isError: executionsError,
    error: executionsErrorObj,
    mutate: mutateExecutions,
  } = useMonitorWorkflows(executionsFilters);

  // Handlers
  const handleTabChange = useCallback(
    (value: string) => {
      const tab = value as TabValue;
      setActiveTab(tab);
      // Update URL without navigation
      const params = new URLSearchParams(searchParams.toString());
      params.set("tab", tab);
      router.replace(`?${params.toString()}`, { scroll: false });
    },
    [router, searchParams]
  );

  const handleRefresh = useCallback(() => {
    if (activeTab === "names") {
      mutateNames();
    } else {
      mutateExecutions();
    }
  }, [activeTab, mutateNames, mutateExecutions]);

  const handleWorkflowNameClick = useCallback(
    (name: string, _appId: string) => {
      // Filter executions by workflow name in the executions tab
      setActiveTab("executions");
      setExecutionsFilters({ search: name });
      const params = new URLSearchParams();
      params.set("tab", "executions");
      params.set("name", name);
      router.replace(`?${params.toString()}`, { scroll: false });
    },
    [router]
  );

  const handleNamesSearchChange = (value: string) => {
    setNamesSearch(value);
  };

  const isLoading = activeTab === "names" ? namesLoading : executionsLoading;
  const _isError = activeTab === "names" ? namesError : executionsError;
  const _error = activeTab === "names" ? namesErrorObj : executionsErrorObj;
  const total = activeTab === "names" ? namesTotal : executionsTotal;

  return (
    <div className="flex h-full flex-col">
      {/* Header */}
      <div className="flex items-center justify-between border-b px-6 py-4">
        <div>
          <h1 className="font-semibold text-2xl">Workflows</h1>
          <p className="text-muted-foreground text-sm">
            View and monitor Dapr workflow executions
          </p>
        </div>
        <Button
          disabled={isLoading}
          onClick={handleRefresh}
          size="sm"
          variant="outline"
        >
          <RefreshCw
            className={`mr-2 h-4 w-4 ${isLoading ? "animate-spin" : ""}`}
          />
          Refresh
        </Button>
      </div>

      {/* Tabs */}
      <Tabs
        className="flex flex-1 flex-col"
        onValueChange={handleTabChange}
        value={activeTab}
      >
        <div className="border-b px-6 pt-4">
          <TabsList>
            <TabsTrigger value="names">Workflow names</TabsTrigger>
            <TabsTrigger value="executions">
              All workflow executions
            </TabsTrigger>
          </TabsList>
        </div>

        {/* Tab Content: Workflow Names */}
        <TabsContent className="m-0 flex flex-1 flex-col" value="names">
          {/* Search bar for names */}
          <div className="border-b px-6 py-4">
            <div className="relative max-w-sm">
              <Search className="absolute top-1/2 left-3 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                className="pl-9"
                onChange={(e) => handleNamesSearchChange(e.target.value)}
                placeholder="Search workflow names..."
                value={namesSearch}
              />
              {namesSearch && (
                <Button
                  className="absolute top-1/2 right-1 h-6 w-6 -translate-y-1/2"
                  onClick={() => handleNamesSearchChange("")}
                  size="icon"
                  variant="ghost"
                >
                  <X className="h-3 w-3" />
                </Button>
              )}
            </div>
          </div>

          {/* Content */}
          <div className="flex-1 overflow-auto p-6">
            {namesError ? (
              <div className="flex h-64 flex-col items-center justify-center text-center">
                <p className="font-medium text-destructive">
                  Failed to load workflow names
                </p>
                <p className="mt-1 text-muted-foreground text-sm">
                  {namesErrorObj?.message || "An unexpected error occurred"}
                </p>
                <Button
                  className="mt-4"
                  onClick={handleRefresh}
                  size="sm"
                  variant="outline"
                >
                  Try again
                </Button>
              </div>
            ) : (
              <WorkflowNamesTable
                isLoading={namesLoading}
                onRowClick={handleWorkflowNameClick}
                workflowNames={workflowNames}
              />
            )}
          </div>
        </TabsContent>

        {/* Tab Content: All Executions */}
        <TabsContent className="m-0 flex flex-1 flex-col" value="executions">
          {/* Filters */}
          <div className="border-b px-6 py-4">
            <WorkflowFiltersComponent
              filters={executionsFilters}
              onFiltersChange={setExecutionsFilters}
            />
          </div>

          {/* Content */}
          <div className="flex-1 overflow-auto p-6">
            {executionsError ? (
              <div className="flex h-64 flex-col items-center justify-center text-center">
                <p className="font-medium text-destructive">
                  Failed to load workflows
                </p>
                <p className="mt-1 text-muted-foreground text-sm">
                  {executionsErrorObj?.message ||
                    "An unexpected error occurred"}
                </p>
                <Button
                  className="mt-4"
                  onClick={handleRefresh}
                  size="sm"
                  variant="outline"
                >
                  Try again
                </Button>
              </div>
            ) : (
              <DaprWorkflowTable
                isLoading={executionsLoading}
                workflows={workflows}
              />
            )}
          </div>
        </TabsContent>
      </Tabs>

      {/* Footer */}
      <div className="border-t bg-muted/30 px-6 py-3">
        <p className="text-right text-muted-foreground text-sm">
          Total Rows: {total}
        </p>
      </div>
    </div>
  );
}
