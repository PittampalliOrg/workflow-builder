"use client";

/**
 * Workflow Execution Detail Page
 * Shows detailed information about a single workflow execution
 */

import { ArrowLeft, ChevronRight, RefreshCw } from "lucide-react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import {
  InputOutputSection,
  WorkflowDetailHeader,
  WorkflowDetailTabs,
} from "@/components/monitor";
import { SidebarToggle } from "@/components/sidebar-toggle";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { useMonitorExecution } from "@/hooks/use-monitor-execution";

// ============================================================================
// Execution Detail View
// ============================================================================

function ExecutionDetailView({ instanceId }: { instanceId: string }) {
  const router = useRouter();

  const { execution, isLoading, isError, mutate } =
    useMonitorExecution(instanceId);

  const handleRefresh = () => {
    mutate();
  };

  if (isLoading && !execution) {
    return (
      <div className="flex h-full flex-col">
        <div className="border-b px-6 py-4">
          <Skeleton className="h-6 w-48" />
        </div>
        <div className="flex-1 space-y-6 p-6">
          <Skeleton className="h-24 w-full" />
          <Skeleton className="h-48 w-full" />
          <Skeleton className="h-64 w-full" />
        </div>
      </div>
    );
  }

  if (isError || !execution) {
    return (
      <div className="flex h-full flex-col items-center justify-center">
        <p className="font-medium text-destructive">
          Workflow execution not found
        </p>
        <Button
          className="mt-4"
          onClick={() => router.push("/monitor")}
          size="sm"
          variant="outline"
        >
          Back to monitor
        </Button>
      </div>
    );
  }

  return (
    <div className="container mx-auto py-6">
      {/* Breadcrumb Header */}
      <div className="mb-6 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <SidebarToggle />
          <Link href="/monitor">
            <Button className="h-8 w-8" size="icon" variant="ghost">
              <ArrowLeft className="h-4 w-4" />
            </Button>
          </Link>
          <div>
            {/* Breadcrumb */}
            <nav className="flex items-center gap-1.5 text-sm">
              <Link
                className="text-muted-foreground transition-colors hover:text-foreground"
                href="/monitor"
              >
                Monitor
              </Link>
              <ChevronRight className="h-3.5 w-3.5 text-muted-foreground" />
              <span className="max-w-[200px] truncate font-medium text-foreground">
                {execution.instanceId.substring(0, 8)}...
              </span>
            </nav>
            {/* Title */}
            <h1 className="mt-0.5 font-bold text-2xl">
              {execution.workflowName || "Workflow Execution"}
            </h1>
          </div>
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

      {/* Content */}
      <div className="space-y-8">
        {/* Workflow Execution Details Section */}
        <section>
          <WorkflowDetailHeader workflow={execution} />
        </section>

        {/* Input/Output Section */}
        <section>
          <h2 className="mb-4 font-semibold text-base">Input / Output</h2>
          <InputOutputSection
            input={execution.input}
            output={execution.output}
          />
        </section>

        {/* Tabbed Section: History, Logs */}
        <section>
          <WorkflowDetailTabs
            events={execution.executionHistory}
            output={execution.output}
          />
        </section>
      </div>
    </div>
  );
}

// ============================================================================
// Main Page Component
// ============================================================================

export default function MonitorDetailPage() {
  const params = useParams();
  const instanceId = params.instanceId as string;

  return <ExecutionDetailView instanceId={instanceId} />;
}
