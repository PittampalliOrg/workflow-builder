"use client";

import { useRouter } from "next/navigation";
import { Check, X, Clock, Pause } from "lucide-react";
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
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  getStatusVariant,
  getPhaseLabel,
  getPhaseColor,
  type WorkflowListItem,
  type WorkflowUIStatus,
} from "@/lib/types/workflow-ui";
import { formatTimestamp, formatAbsoluteTimestamp, calculateDuration } from "@/lib/transforms/workflow-ui";
import { cn } from "@/lib/utils";
import { Progress } from "@/components/ui/progress";

// Status icon component
function StatusIcon({ status }: { status: WorkflowUIStatus }) {
  switch (status) {
    case "COMPLETED":
      return <Check className="h-3.5 w-3.5" />;
    case "RUNNING":
      return <Clock className="h-3.5 w-3.5" />;
    case "FAILED":
      return <X className="h-3.5 w-3.5" />;
    case "SUSPENDED":
      return <Pause className="h-3.5 w-3.5" />;
    case "CANCELLED":
      return <X className="h-3.5 w-3.5" />;
    default:
      return null;
  }
}

// Status badge colors to match Diagrid
function getStatusBadgeClasses(status: WorkflowUIStatus): string {
  switch (status) {
    case "COMPLETED":
      return "bg-green-600 hover:bg-green-700 text-white";
    case "RUNNING":
      return "bg-amber-500 hover:bg-amber-600 text-white";
    case "FAILED":
      return "bg-red-600 hover:bg-red-700 text-white";
    case "SUSPENDED":
      return "bg-gray-500 hover:bg-gray-600 text-white";
    case "CANCELLED":
      return "bg-gray-600 hover:bg-gray-700 text-white";
    default:
      return "bg-gray-500 hover:bg-gray-600 text-white";
  }
}

interface DaprWorkflowTableProps {
  workflows: WorkflowListItem[];
  isLoading?: boolean;
}

function WorkflowTableSkeleton() {
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead className="w-28">Status</TableHead>
          <TableHead>Instance ID</TableHead>
          <TableHead>Type</TableHead>
          <TableHead>App ID</TableHead>
          <TableHead>Phase</TableHead>
          <TableHead>Start Time</TableHead>
          <TableHead>Execution Time</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {Array.from({ length: 5 }).map((_, i) => (
          <TableRow key={i}>
            <TableCell>
              <Skeleton className="h-5 w-20" />
            </TableCell>
            <TableCell>
              <Skeleton className="h-4 w-24" />
            </TableCell>
            <TableCell>
              <Skeleton className="h-4 w-32" />
            </TableCell>
            <TableCell>
              <Skeleton className="h-4 w-28" />
            </TableCell>
            <TableCell>
              <Skeleton className="h-4 w-24" />
            </TableCell>
            <TableCell>
              <Skeleton className="h-4 w-20" />
            </TableCell>
            <TableCell>
              <Skeleton className="h-4 w-16" />
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

function WorkflowRow({ workflow }: { workflow: WorkflowListItem }) {
  const router = useRouter();

  const handleClick = () => {
    if (workflow.instanceId) {
      router.push(`/monitor/${workflow.instanceId}`);
    }
  };

  const customStatus = workflow.customStatus;
  const hasPhase = customStatus?.phase;

  return (
    <TableRow
      className={cn(
        "border-b border-gray-700",
        workflow.instanceId ? "cursor-pointer hover:bg-[#252c3d]" : "opacity-50"
      )}
      onClick={handleClick}
    >
      <TableCell>
        <Badge
          variant={getStatusVariant(workflow.status)}
          className={cn("gap-1.5", getStatusBadgeClasses(workflow.status))}
        >
          <StatusIcon status={workflow.status} />
          {workflow.status}
        </Badge>
      </TableCell>
      <TableCell>
        <Tooltip>
          <TooltipTrigger asChild>
            <span className="font-mono text-sm text-white cursor-help">
              {workflow.instanceId ? `${workflow.instanceId.substring(0, 20)}${workflow.instanceId.length > 20 ? "..." : ""}` : "-"}
            </span>
          </TooltipTrigger>
          <TooltipContent side="top" className="font-mono text-xs">
            {workflow.instanceId || "Unknown"}
          </TooltipContent>
        </Tooltip>
      </TableCell>
      <TableCell className="text-gray-400">
        {workflow.workflowType}
      </TableCell>
      <TableCell className="text-gray-400">{workflow.appId}</TableCell>
      <TableCell>
        {customStatus?.currentTask ? (
          <div className="flex flex-col gap-1">
            <span className="text-sm text-blue-400 truncate max-w-[200px]" title={customStatus.currentTask}>
              {customStatus.currentTask}
            </span>
            {customStatus.progress != null && workflow.status === "RUNNING" && (
              <div className="flex items-center gap-2">
                <Progress value={customStatus.progress} className="h-1.5 w-16" />
                <span className="text-xs text-gray-500">{customStatus.progress}%</span>
              </div>
            )}
          </div>
        ) : hasPhase ? (
          <div className="flex flex-col gap-1">
            <span className={cn("text-sm capitalize", getPhaseColor(customStatus.phase))}>
              {getPhaseLabel(customStatus.phase)}
            </span>
            {customStatus.progress != null && workflow.status === "RUNNING" && (
              <div className="flex items-center gap-2">
                <Progress value={customStatus.progress} className="h-1.5 w-16" />
                <span className="text-xs text-gray-500">{customStatus.progress}%</span>
              </div>
            )}
          </div>
        ) : (
          <span className="text-gray-500">-</span>
        )}
      </TableCell>
      <TableCell>
        <Tooltip>
          <TooltipTrigger asChild>
            <span className="text-gray-400 cursor-help">
              {formatTimestamp(workflow.startTime)}
            </span>
          </TooltipTrigger>
          <TooltipContent side="top" className="text-xs">
            {formatAbsoluteTimestamp(workflow.startTime)}
          </TooltipContent>
        </Tooltip>
      </TableCell>
      <TableCell>
        {workflow.status === "RUNNING" ? (
          <Tooltip>
            <TooltipTrigger asChild>
              <span className="text-amber-400 cursor-help font-medium">
                {calculateDuration(workflow.startTime) || "-"}
              </span>
            </TooltipTrigger>
            <TooltipContent side="top" className="text-xs">
              Running for {calculateDuration(workflow.startTime)}
            </TooltipContent>
          </Tooltip>
        ) : workflow.endTime ? (
          <Tooltip>
            <TooltipTrigger asChild>
              <span className="text-gray-400 cursor-help">
                {calculateDuration(workflow.startTime, workflow.endTime) || "-"}
              </span>
            </TooltipTrigger>
            <TooltipContent side="top" className="text-xs">
              Completed in {calculateDuration(workflow.startTime, workflow.endTime)}
            </TooltipContent>
          </Tooltip>
        ) : (
          <span className="text-gray-500">-</span>
        )}
      </TableCell>
    </TableRow>
  );
}

export function DaprWorkflowTable({
  workflows,
  isLoading,
}: DaprWorkflowTableProps) {
  if (isLoading) {
    return <WorkflowTableSkeleton />;
  }

  if (!workflows.length) {
    return (
      <div className="text-center py-12 text-gray-400">
        No workflow executions found
      </div>
    );
  }

  return (
    <div className="rounded-lg border border-gray-700 bg-[#1a1f2e] overflow-hidden">
      <Table>
        <TableHeader>
          <TableRow className="border-b border-gray-700 bg-[#1e2433] hover:bg-[#1e2433]">
            <TableHead className="w-32 text-gray-400 font-medium">Status</TableHead>
            <TableHead className="text-gray-400 font-medium">Instance ID</TableHead>
            <TableHead className="text-gray-400 font-medium">Type</TableHead>
            <TableHead className="text-gray-400 font-medium">App ID</TableHead>
            <TableHead className="text-gray-400 font-medium">Phase</TableHead>
            <TableHead className="text-gray-400 font-medium">Start Time</TableHead>
            <TableHead className="text-gray-400 font-medium">Execution Time</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {workflows.map((workflow, index) => (
            <WorkflowRow key={workflow.instanceId || `workflow-${index}`} workflow={workflow} />
          ))}
        </TableBody>
      </Table>
    </div>
  );
}
