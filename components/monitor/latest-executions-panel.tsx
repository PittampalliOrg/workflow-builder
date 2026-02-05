"use client";

/**
 * LatestExecutionsPanel Component
 *
 * Panel showing recent workflow executions with navigation.
 */

import { useRouter } from "next/navigation";
import { Check, Circle, ChevronRight } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { getStatusVariant, type WorkflowListItem } from "@/lib/types/workflow-ui";
import { calculateDuration } from "@/lib/transforms/workflow-ui";
import { cn } from "@/lib/utils";

// ============================================================================
// Types
// ============================================================================

interface LatestExecutionsPanelProps {
  executions: WorkflowListItem[];
  workflowName: string;
  appId: string;
  isLoading?: boolean;
}

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
        {Array.from({ length: 5 }).map((_, i) => (
          <div key={i} className="flex items-center justify-between p-3 rounded-lg border">
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

interface ExecutionItemProps {
  execution: WorkflowListItem;
  onClick: () => void;
}

function ExecutionItem({ execution, onClick }: ExecutionItemProps) {
  const duration = execution.endTime
    ? calculateDuration(execution.startTime, execution.endTime)
    : calculateDuration(execution.startTime); // Running duration

  return (
    <div
      className="flex items-center justify-between p-3 rounded-lg border hover:bg-muted/50 cursor-pointer transition-colors"
      onClick={onClick}
    >
      <div className="flex items-center gap-3 min-w-0">
        <div className="min-w-0">
          <Tooltip>
            <TooltipTrigger asChild>
              <p className="font-mono text-sm truncate">
                {execution.instanceId.substring(0, 12)}...
              </p>
            </TooltipTrigger>
            <TooltipContent side="top" className="font-mono text-xs">
              {execution.instanceId}
            </TooltipContent>
          </Tooltip>
          <p className="text-xs text-muted-foreground">
            {duration || "-"}
          </p>
        </div>
      </div>
      <div className="flex items-center gap-2">
        <Badge
          variant={getStatusVariant(execution.status)}
          className={cn(
            "gap-1 text-xs",
            execution.status === "COMPLETED" && "bg-green-600 hover:bg-green-700",
            execution.status === "RUNNING" && "bg-amber-500 hover:bg-amber-600"
          )}
        >
          {execution.status === "COMPLETED" && <Check className="h-3 w-3" />}
          {execution.status === "RUNNING" && (
            <Circle className="h-2 w-2 fill-current animate-pulse" />
          )}
          {execution.status}
        </Badge>
        <ChevronRight className="h-4 w-4 text-muted-foreground" />
      </div>
    </div>
  );
}

// ============================================================================
// Main Component
// ============================================================================

export function LatestExecutionsPanel({
  executions,
  workflowName,
  appId,
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
            variant="link"
            size="sm"
            className="text-cyan-500 hover:text-cyan-400 p-0 h-auto"
            onClick={handleSeeAllClick}
          >
            See all executions
          </Button>
        </div>
      </CardHeader>
      <CardContent className="space-y-2">
        {executions.length === 0 ? (
          <p className="text-center text-muted-foreground py-4">
            No executions found
          </p>
        ) : (
          executions.map((execution) => (
            <ExecutionItem
              key={execution.instanceId}
              execution={execution}
              onClick={() => handleExecutionClick(execution.instanceId)}
            />
          ))
        )}
      </CardContent>
    </Card>
  );
}
