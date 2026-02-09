"use client";

/**
 * WorkflowNamesTable Component
 *
 * Table displaying aggregated workflow statistics by name.
 * Used in the "Workflow names" tab.
 */

import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import type { WorkflowNameStats } from "@/lib/types/workflow-ui";

// ============================================================================
// Types
// ============================================================================

type WorkflowNamesTableProps = {
  workflowNames: WorkflowNameStats[];
  isLoading?: boolean;
  onRowClick?: (name: string, appId: string) => void;
};

// ============================================================================
// Skeleton Component
// ============================================================================

function WorkflowNamesTableSkeleton() {
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Name</TableHead>
          <TableHead>App ID</TableHead>
          <TableHead className="text-right">Total Executions</TableHead>
          <TableHead className="text-right">Running</TableHead>
          <TableHead className="text-right">Success</TableHead>
          <TableHead className="text-right">Failed</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {["1", "2", "3", "4", "5"].map((k) => (
          <TableRow key={k}>
            <TableCell>
              <Skeleton className="h-4 w-40" />
            </TableCell>
            <TableCell>
              <Skeleton className="h-4 w-32" />
            </TableCell>
            <TableCell className="text-right">
              <Skeleton className="ml-auto h-5 w-12" />
            </TableCell>
            <TableCell className="text-right">
              <Skeleton className="ml-auto h-5 w-10" />
            </TableCell>
            <TableCell className="text-right">
              <Skeleton className="ml-auto h-5 w-10" />
            </TableCell>
            <TableCell className="text-right">
              <Skeleton className="ml-auto h-5 w-10" />
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

// ============================================================================
// Row Component
// ============================================================================

type WorkflowNameRowProps = {
  stats: WorkflowNameStats;
  onClick?: () => void;
};

function WorkflowNameRow({ stats, onClick }: WorkflowNameRowProps) {
  return (
    <TableRow
      className={onClick ? "cursor-pointer hover:bg-muted/50" : undefined}
      onClick={onClick}
    >
      <TableCell className="font-medium">{stats.name}</TableCell>
      <TableCell className="text-muted-foreground">{stats.appId}</TableCell>
      <TableCell className="text-right">
        <Badge className="font-mono" variant="outline">
          {stats.totalExecutions}
        </Badge>
      </TableCell>
      <TableCell className="text-right">
        {stats.runningCount > 0 ? (
          <Badge
            className="bg-amber-500/15 font-mono text-amber-600 hover:bg-amber-500/25"
            variant="secondary"
          >
            {stats.runningCount}
          </Badge>
        ) : (
          <span className="text-muted-foreground">0</span>
        )}
      </TableCell>
      <TableCell className="text-right">
        {stats.successCount > 0 ? (
          <Badge
            className="bg-green-500/15 font-mono text-green-600 hover:bg-green-500/25"
            variant="secondary"
          >
            {stats.successCount}
          </Badge>
        ) : (
          <span className="text-muted-foreground">0</span>
        )}
      </TableCell>
      <TableCell className="text-right">
        {stats.failedCount > 0 ? (
          <Badge
            className="bg-red-500/15 font-mono text-red-600 hover:bg-red-500/25"
            variant="destructive"
          >
            {stats.failedCount}
          </Badge>
        ) : (
          <span className="text-muted-foreground">0</span>
        )}
      </TableCell>
    </TableRow>
  );
}

// ============================================================================
// Main Component
// ============================================================================

export function WorkflowNamesTable({
  workflowNames,
  isLoading,
  onRowClick,
}: WorkflowNamesTableProps) {
  if (isLoading) {
    return <WorkflowNamesTableSkeleton />;
  }

  if (!workflowNames.length) {
    return (
      <div className="py-12 text-center text-muted-foreground">
        No workflow types found
      </div>
    );
  }

  return (
    <div className="rounded-md border">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Name</TableHead>
            <TableHead>App ID</TableHead>
            <TableHead className="text-right">Total Executions</TableHead>
            <TableHead className="text-right">Running</TableHead>
            <TableHead className="text-right">Success</TableHead>
            <TableHead className="text-right">Failed</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {workflowNames.map((stats) => (
            <WorkflowNameRow
              key={`${stats.name}:${stats.appId}`}
              onClick={
                onRowClick
                  ? () => onRowClick(stats.name, stats.appId)
                  : undefined
              }
              stats={stats}
            />
          ))}
        </TableBody>
      </Table>
    </div>
  );
}
