"use client";

/**
 * WorkflowPageTabs Component
 *
 * Main tabs wrapper for the workflows page with two tabs:
 * - "Workflow names" - Aggregated view showing workflow types with execution stats
 * - "All workflow executions" - Existing executions table
 */

import { useState, useCallback } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { RefreshCw, Search, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { DaprWorkflowTable } from "./dapr-workflow-table";
import { WorkflowFilters as WorkflowFiltersComponent } from "./workflow-filters";
import { WorkflowNamesTable } from "./workflow-names-table";
import { useMonitorWorkflows } from "@/hooks/use-monitor-workflows";
import { useMonitorByName } from "@/hooks/use-monitor-by-name";
import type { WorkflowFilters } from "@/lib/types/workflow-ui";

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
    (name: string, appId: string) => {
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
  const isError = activeTab === "names" ? namesError : executionsError;
  const error = activeTab === "names" ? namesErrorObj : executionsErrorObj;
  const total = activeTab === "names" ? namesTotal : executionsTotal;

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="flex items-center justify-between px-6 py-4 border-b">
        <div>
          <h1 className="text-2xl font-semibold">Workflows</h1>
          <p className="text-sm text-muted-foreground">
            View and monitor Dapr workflow executions
          </p>
        </div>
        <Button
          variant="outline"
          size="sm"
          onClick={handleRefresh}
          disabled={isLoading}
        >
          <RefreshCw className={`h-4 w-4 mr-2 ${isLoading ? "animate-spin" : ""}`} />
          Refresh
        </Button>
      </div>

      {/* Tabs */}
      <Tabs
        value={activeTab}
        onValueChange={handleTabChange}
        className="flex-1 flex flex-col"
      >
        <div className="px-6 pt-4 border-b">
          <TabsList>
            <TabsTrigger value="names">Workflow names</TabsTrigger>
            <TabsTrigger value="executions">All workflow executions</TabsTrigger>
          </TabsList>
        </div>

        {/* Tab Content: Workflow Names */}
        <TabsContent value="names" className="flex-1 flex flex-col m-0">
          {/* Search bar for names */}
          <div className="px-6 py-4 border-b">
            <div className="relative max-w-sm">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
              <Input
                placeholder="Search workflow names..."
                value={namesSearch}
                onChange={(e) => handleNamesSearchChange(e.target.value)}
                className="pl-9"
              />
              {namesSearch && (
                <Button
                  variant="ghost"
                  size="icon"
                  className="absolute right-1 top-1/2 -translate-y-1/2 h-6 w-6"
                  onClick={() => handleNamesSearchChange("")}
                >
                  <X className="h-3 w-3" />
                </Button>
              )}
            </div>
          </div>

          {/* Content */}
          <div className="flex-1 overflow-auto p-6">
            {namesError ? (
              <div className="flex flex-col items-center justify-center h-64 text-center">
                <p className="text-destructive font-medium">Failed to load workflow names</p>
                <p className="text-sm text-muted-foreground mt-1">
                  {namesErrorObj?.message || "An unexpected error occurred"}
                </p>
                <Button variant="outline" size="sm" className="mt-4" onClick={handleRefresh}>
                  Try again
                </Button>
              </div>
            ) : (
              <WorkflowNamesTable
                workflowNames={workflowNames}
                isLoading={namesLoading}
                onRowClick={handleWorkflowNameClick}
              />
            )}
          </div>
        </TabsContent>

        {/* Tab Content: All Executions */}
        <TabsContent value="executions" className="flex-1 flex flex-col m-0">
          {/* Filters */}
          <div className="px-6 py-4 border-b">
            <WorkflowFiltersComponent
              filters={executionsFilters}
              onFiltersChange={setExecutionsFilters}
            />
          </div>

          {/* Content */}
          <div className="flex-1 overflow-auto p-6">
            {executionsError ? (
              <div className="flex flex-col items-center justify-center h-64 text-center">
                <p className="text-destructive font-medium">Failed to load workflows</p>
                <p className="text-sm text-muted-foreground mt-1">
                  {executionsErrorObj?.message || "An unexpected error occurred"}
                </p>
                <Button variant="outline" size="sm" className="mt-4" onClick={handleRefresh}>
                  Try again
                </Button>
              </div>
            ) : (
              <DaprWorkflowTable workflows={workflows} isLoading={executionsLoading} />
            )}
          </div>
        </TabsContent>
      </Tabs>

      {/* Footer */}
      <div className="px-6 py-3 border-t bg-muted/30">
        <p className="text-sm text-muted-foreground text-right">
          Total Rows: {total}
        </p>
      </div>
    </div>
  );
}
