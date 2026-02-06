"use client";

/**
 * WorkflowNameStats Component
 *
 * Stats cards showing execution metrics for a workflow name.
 * Displays: Executions, Running, Success, Failed, Success rate.
 */

import { Activity, CheckCircle, Clock, XCircle, TrendingUp } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { Skeleton } from "@/components/ui/skeleton";
import type { WorkflowNameStats as WorkflowNameStatsType } from "@/lib/types/workflow-ui";

// ============================================================================
// Types
// ============================================================================

interface WorkflowNameStatsProps {
  stats: WorkflowNameStatsType | null;
  isLoading?: boolean;
}

// ============================================================================
// Skeleton Component
// ============================================================================

function WorkflowNameStatsSkeleton() {
  return (
    <div className="grid grid-cols-2 md:grid-cols-5 gap-4">
      {Array.from({ length: 5 }).map((_, i) => (
        <Card key={i}>
          <CardContent className="p-4">
            <Skeleton className="h-4 w-20 mb-2" />
            <Skeleton className="h-8 w-16" />
          </CardContent>
        </Card>
      ))}
    </div>
  );
}

// ============================================================================
// Stat Card Component
// ============================================================================

interface StatCardProps {
  title: string;
  value: string | number;
  icon: React.ReactNode;
  iconColor?: string;
  progress?: number;
  progressColor?: string;
}

function StatCard({
  title,
  value,
  icon,
  iconColor = "text-muted-foreground",
  progress,
  progressColor,
}: StatCardProps) {
  return (
    <Card>
      <CardContent className="p-4">
        <div className="flex items-center gap-2 mb-2">
          <span className={iconColor}>{icon}</span>
          <span className="text-sm text-muted-foreground">{title}</span>
        </div>
        <div className="text-2xl font-bold">{value}</div>
        {progress !== undefined && (
          <div className="mt-2">
            <Progress
              value={progress}
              className="h-1.5"
              style={
                progressColor
                  ? { ["--progress-background" as string]: progressColor }
                  : undefined
              }
            />
          </div>
        )}
      </CardContent>
    </Card>
  );
}

// ============================================================================
// Main Component
// ============================================================================

export function WorkflowNameStats({ stats, isLoading }: WorkflowNameStatsProps) {
  if (isLoading) {
    return <WorkflowNameStatsSkeleton />;
  }

  if (!stats) {
    return (
      <div className="text-center py-8 text-muted-foreground">
        No statistics available
      </div>
    );
  }

  const successRate =
    stats.totalExecutions > 0
      ? Math.round((stats.successCount / stats.totalExecutions) * 100)
      : 0;

  return (
    <div className="grid grid-cols-2 md:grid-cols-5 gap-4">
      {/* Executions */}
      <StatCard
        title="Executions"
        value={stats.totalExecutions}
        icon={<Activity className="h-4 w-4" />}
      />

      {/* Running */}
      <StatCard
        title="Running"
        value={stats.runningCount}
        icon={<Clock className="h-4 w-4" />}
        iconColor="text-cyan-500"
      />

      {/* Success */}
      <StatCard
        title="Success"
        value={stats.successCount}
        icon={<CheckCircle className="h-4 w-4" />}
        iconColor="text-green-500"
      />

      {/* Failed */}
      <StatCard
        title="Failed"
        value={stats.failedCount}
        icon={<XCircle className="h-4 w-4" />}
        iconColor="text-red-500"
      />

      {/* Success Rate */}
      <StatCard
        title="Success rate"
        value={`${successRate}%`}
        icon={<TrendingUp className="h-4 w-4" />}
        iconColor="text-green-500"
        progress={successRate}
        progressColor="rgb(34 197 94)"
      />
    </div>
  );
}
