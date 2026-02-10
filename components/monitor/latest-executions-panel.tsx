"use client";

/**
 * LatestExecutionsPanel Component
 *
 * Panel showing recent workflow executions with navigation.
 */

import { Check, ChevronRight, Circle } from "lucide-react";
import { useRouter } from "next/navigation";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { calculateDuration } from "@/lib/transforms/workflow-ui";
import {
  getStatusVariant,
  type WorkflowListItem,
} from "@/lib/types/workflow-ui";
import { cn } from "@/lib/utils";

// ============================================================================
// Types
// ============================================================================

type LatestExecutionsPanelProps = {
  executions: WorkflowListItem[];
  workflowName: string;
  isLoading?: boolean;
};

// ============================================================================
// Skeleton Component
// ============================================================================

function LatestExecutionsPanelSkeleton() {
  return (
    <Card>
      <CardHeader className="pb-3">
        <Skeleton className="h-5 w-40" />
      </CardHeader>
      <CardContent className="space-y-3">
        {["1", "2", "3", "4", "5"].map((k) => (
          <div
            className="flex items-center justify-between rounded-lg border p-3"
            key={k}
          >
            <div className="space-y-2">
              <Skeleton className="h-4 w-24" />
              <Skeleton className="h-3 w-16" />
            </div>
            <Skeleton className="h-5 w-16" />
          </div>
        ))}
      </CardContent>
    </Card>
  );
}

// ============================================================================
// Execution Item Component
// ============================================================================

type ExecutionItemProps = {
  execution: WorkflowListItem;
  onClick: () => void;
};

function ExecutionItem({ execution, onClick }: ExecutionItemProps) {
  const duration = execution.endTime
    ? calculateDuration(execution.startTime, execution.endTime)
    : calculateDuration(execution.startTime); // Running duration

  return (
    <button
      className="flex w-full cursor-pointer items-center justify-between rounded-lg border p-3 text-left transition-colors hover:bg-muted/50"
      onClick={onClick}
      type="button"
    >
      <div className="flex min-w-0 items-center gap-3">
        <div className="min-w-0">
          <Tooltip>
            <TooltipTrigger asChild>
              <p className="truncate font-mono text-sm">
                {execution.instanceId.substring(0, 12)}...
              </p>
            </TooltipTrigger>
            <TooltipContent className="font-mono text-xs" side="top">
              {execution.instanceId}
            </TooltipContent>
          </Tooltip>
          <p className="text-muted-foreground text-xs">{duration || "-"}</p>
        </div>
      </div>
      <div className="flex items-center gap-2">
        <Badge
          className={cn(
            "gap-1 text-xs",
            execution.status === "COMPLETED" &&
              "bg-green-600 hover:bg-green-700",
            execution.status === "RUNNING" && "bg-amber-500 hover:bg-amber-600"
          )}
          variant={getStatusVariant(execution.status)}
        >
          {execution.status === "COMPLETED" && <Check className="h-3 w-3" />}
          {execution.status === "RUNNING" && (
            <Circle className="h-2 w-2 animate-pulse fill-current" />
          )}
          {execution.status}
        </Badge>
        <ChevronRight className="h-4 w-4 text-muted-foreground" />
      </div>
    </button>
  );
}

// ============================================================================
// Main Component
// ============================================================================

export function LatestExecutionsPanel({
  executions,
  workflowName,
  isLoading,
}: LatestExecutionsPanelProps) {
  const router = useRouter();

  const handleExecutionClick = (instanceId: string) => {
    router.push(`/monitor/${instanceId}`);
  };

  const handleSeeAllClick = () => {
    const params = new URLSearchParams();
    params.set("tab", "executions");
    params.set("name", workflowName);
    router.push(`/monitor?${params.toString()}`);
  };

  if (isLoading) {
    return <LatestExecutionsPanelSkeleton />;
  }

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <CardTitle className="text-base">
            Latest {executions.length} executions
          </CardTitle>
          <Button
            className="h-auto p-0 text-cyan-500 hover:text-cyan-400"
            onClick={handleSeeAllClick}
            size="sm"
            variant="link"
          >
            See all executions
          </Button>
        </div>
      </CardHeader>
      <CardContent className="space-y-2">
        {executions.length === 0 ? (
          <p className="py-4 text-center text-muted-foreground">
            No executions found
          </p>
        ) : (
          executions.map((execution) => (
            <ExecutionItem
              execution={execution}
              key={execution.instanceId}
              onClick={() => handleExecutionClick(execution.instanceId)}
            />
          ))
        )}
      </CardContent>
    </Card>
  );
}
