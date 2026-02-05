"use client";

import { Suspense } from "react";
import { WorkflowPageTabs } from "@/components/monitor/workflow-page-tabs";
import { SidebarToggle } from "@/components/sidebar-toggle";
import { Skeleton } from "@/components/ui/skeleton";

function WorkflowPageSkeleton() {
  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center justify-between px-6 py-4 border-b">
        <div>
          <Skeleton className="h-8 w-32" />
          <Skeleton className="h-4 w-64 mt-2" />
        </div>
        <Skeleton className="h-9 w-24" />
      </div>
      <div className="px-6 pt-4 border-b">
        <Skeleton className="h-10 w-80" />
      </div>
      <div className="flex-1 p-6">
        <Skeleton className="h-64 w-full" />
      </div>
    </div>
  );
}

export default function MonitorPage() {
  return (
    <div className="container mx-auto py-6">
      <div className="mb-6">
        <div className="flex items-center gap-4 mb-2">
          <SidebarToggle />
          <h1 className="text-3xl font-bold">Workflow Monitor</h1>
        </div>
        <p className="text-muted-foreground">
          View and monitor workflow executions in real-time
        </p>
      </div>
      <Suspense fallback={<WorkflowPageSkeleton />}>
        <WorkflowPageTabs />
      </Suspense>
    </div>
  );
}
