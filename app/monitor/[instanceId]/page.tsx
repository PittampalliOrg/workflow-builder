"use client";

/**
 * Workflow Execution Detail Page
 * Shows detailed information about a single workflow execution
 */

import { useParams, useRouter } from "next/navigation";
import Link from "next/link";
import { ArrowLeft, ChevronRight, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import {
  InputOutputSection,
  WorkflowDetailHeader,
  WorkflowDetailTabs,
} from "@/components/monitor";
import { SidebarToggle } from "@/components/sidebar-toggle";
import { useMonitorExecution } from "@/hooks/use-monitor-execution";

// ============================================================================
// Execution Detail View
// ============================================================================

function ExecutionDetailView({ instanceId }: { instanceId: string }) {
  const router = useRouter();

  const { execution, isLoading, isError, mutate } = useMonitorExecution(instanceId);

  const handleRefresh = () => {
    mutate();
  };

  if (isLoading && !execution) {
    return (
      <div className="flex flex-col h-full">
        <div className="px-6 py-4 border-b">
          <Skeleton className="h-6 w-48" />
        </div>
        <div className="flex-1 p-6 space-y-6">
          <Skeleton className="h-24 w-full" />
          <Skeleton className="h-48 w-full" />
          <Skeleton className="h-64 w-full" />
        </div>
      </div>
    );
  }

  if (isError || !execution) {
    return (
      <div className="flex flex-col items-center justify-center h-full">
        <p className="text-destructive font-medium">
          Workflow execution not found
        </p>
        <Button
          variant="outline"
          size="sm"
          className="mt-4"
          onClick={() => router.push("/monitor")}
        >
          Back to monitor
        </Button>
      </div>
    );
  }

  return (
    <div className="container mx-auto py-6">
      {/* Breadcrumb Header */}
      <div className="flex items-center justify-between mb-6">
        <div className="flex items-center gap-3">
          <SidebarToggle />
          <Link href="/monitor">
            <Button variant="ghost" size="icon" className="h-8 w-8">
              <ArrowLeft className="h-4 w-4" />
            </Button>
          </Link>
          <div>
            {/* Breadcrumb */}
            <nav className="flex items-center gap-1.5 text-sm">
              <Link
                href="/monitor"
                className="text-muted-foreground hover:text-foreground transition-colors"
              >
                Monitor
              </Link>
              <ChevronRight className="h-3.5 w-3.5 text-muted-foreground" />
              <span className="text-foreground font-medium truncate max-w-[200px]">
                {execution.instanceId.substring(0, 8)}...
              </span>
            </nav>
            {/* Title */}
            <h1 className="text-2xl font-bold mt-0.5">
              {execution.workflowName || "Workflow Execution"}
            </h1>
          </div>
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

      {/* Content */}
      <div className="space-y-8">
        {/* Workflow Execution Details Section */}
        <section>
          <WorkflowDetailHeader workflow={execution} />
        </section>

        {/* Input/Output Section */}
        <section>
          <h2 className="text-base font-semibold mb-4">Input / Output</h2>
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
