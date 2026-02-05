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

interface WorkflowNamesTableProps {
  workflowNames: WorkflowNameStats[];
  isLoading?: boolean;
  onRowClick?: (name: string, appId: string) => void;
}

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
        {Array.from({ length: 5 }).map((_, i) => (
          <TableRow key={i}>
            <TableCell>
              <Skeleton className="h-4 w-40" />
            </TableCell>
            <TableCell>
              <Skeleton className="h-4 w-32" />
            </TableCell>
            <TableCell className="text-right">
              <Skeleton className="h-5 w-12 ml-auto" />
            </TableCell>
            <TableCell className="text-right">
              <Skeleton className="h-5 w-10 ml-auto" />
            </TableCell>
            <TableCell className="text-right">
              <Skeleton className="h-5 w-10 ml-auto" />
            </TableCell>
            <TableCell className="text-right">
              <Skeleton className="h-5 w-10 ml-auto" />
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

interface WorkflowNameRowProps {
  stats: WorkflowNameStats;
  onClick?: () => void;
}

function WorkflowNameRow({ stats, onClick }: WorkflowNameRowProps) {
  return (
    <TableRow
      className={onClick ? "cursor-pointer hover:bg-muted/50" : undefined}
      onClick={onClick}
    >
      <TableCell className="font-medium">{stats.name}</TableCell>
      <TableCell className="text-muted-foreground">{stats.appId}</TableCell>
      <TableCell className="text-right">
        <Badge variant="outline" className="font-mono">
          {stats.totalExecutions}
        </Badge>
      </TableCell>
      <TableCell className="text-right">
        {stats.runningCount > 0 ? (
          <Badge variant="secondary" className="bg-amber-500/15 text-amber-600 hover:bg-amber-500/25 font-mono">
            {stats.runningCount}
          </Badge>
        ) : (
          <span className="text-muted-foreground">0</span>
        )}
      </TableCell>
      <TableCell className="text-right">
        {stats.successCount > 0 ? (
          <Badge variant="secondary" className="bg-green-500/15 text-green-600 hover:bg-green-500/25 font-mono">
            {stats.successCount}
          </Badge>
        ) : (
          <span className="text-muted-foreground">0</span>
        )}
      </TableCell>
      <TableCell className="text-right">
        {stats.failedCount > 0 ? (
          <Badge variant="destructive" className="bg-red-500/15 text-red-600 hover:bg-red-500/25 font-mono">
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
      <div className="text-center py-12 text-muted-foreground">
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
              stats={stats}
              onClick={onRowClick ? () => onRowClick(stats.name, stats.appId) : undefined}
            />
          ))}
        </TableBody>
      </Table>
    </div>
  );
}
