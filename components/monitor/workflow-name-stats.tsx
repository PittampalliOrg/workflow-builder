"use client";

/**
 * WorkflowNameStats Component
 *
 * Stats cards showing execution metrics for a workflow name.
 * Displays: Executions, Running, Success, Failed, Success rate.
 */

import {
  Activity,
  CheckCircle,
  Clock,
  TrendingUp,
  XCircle,
} from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { Skeleton } from "@/components/ui/skeleton";
import type { WorkflowNameStats as WorkflowNameStatsType } from "@/lib/types/workflow-ui";

// ============================================================================
// Types
// ============================================================================

type WorkflowNameStatsProps = {
  stats: WorkflowNameStatsType | null;
  isLoading?: boolean;
};

// ============================================================================
// Skeleton Component
// ============================================================================

function WorkflowNameStatsSkeleton() {
  return (
    <div className="grid grid-cols-2 gap-4 md:grid-cols-5">
      {["1", "2", "3", "4", "5"].map((k) => (
        <Card key={k}>
          <CardContent className="p-4">
            <Skeleton className="mb-2 h-4 w-20" />
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

type StatCardProps = {
  title: string;
  value: string | number;
  icon: React.ReactNode;
  iconColor?: string;
  progress?: number;
  progressColor?: string;
};

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
        <div className="mb-2 flex items-center gap-2">
          <span className={iconColor}>{icon}</span>
          <span className="text-muted-foreground text-sm">{title}</span>
        </div>
        <div className="font-bold text-2xl">{value}</div>
        {progress !== undefined && (
          <div className="mt-2">
            <Progress
              className="h-1.5"
              style={
                progressColor
                  ? { ["--progress-background" as string]: progressColor }
                  : undefined
              }
              value={progress}
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

export function WorkflowNameStats({
  stats,
  isLoading,
}: WorkflowNameStatsProps) {
  if (isLoading) {
    return <WorkflowNameStatsSkeleton />;
  }

  if (!stats) {
    return (
      <div className="py-8 text-center text-muted-foreground">
        No statistics available
      </div>
    );
  }

  const successRate =
    stats.totalExecutions > 0
      ? Math.round((stats.successCount / stats.totalExecutions) * 100)
      : 0;

  return (
    <div className="grid grid-cols-2 gap-4 md:grid-cols-5">
      {/* Executions */}
      <StatCard
        icon={<Activity className="h-4 w-4" />}
        title="Executions"
        value={stats.totalExecutions}
      />

      {/* Running */}
      <StatCard
        icon={<Clock className="h-4 w-4" />}
        iconColor="text-cyan-500"
        title="Running"
        value={stats.runningCount}
      />

      {/* Success */}
      <StatCard
        icon={<CheckCircle className="h-4 w-4" />}
        iconColor="text-green-500"
        title="Success"
        value={stats.successCount}
      />

      {/* Failed */}
      <StatCard
        icon={<XCircle className="h-4 w-4" />}
        iconColor="text-red-500"
        title="Failed"
        value={stats.failedCount}
      />

      {/* Success Rate */}
      <StatCard
        icon={<TrendingUp className="h-4 w-4" />}
        iconColor="text-green-500"
        progress={successRate}
        progressColor="rgb(34 197 94)"
        title="Success rate"
        value={`${successRate}%`}
      />
    </div>
  );
}
