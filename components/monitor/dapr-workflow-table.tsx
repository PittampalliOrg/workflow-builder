"use client";

import { Check, Clock, Pause, X } from "lucide-react";
import { useRouter } from "next/navigation";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
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
  calculateDuration,
  formatAbsoluteTimestamp,
  formatTimestamp,
} from "@/lib/transforms/workflow-ui";
import {
  getPhaseColor,
  getPhaseLabel,
  getStatusVariant,
  type WorkflowListItem,
  type WorkflowUIStatus,
} from "@/lib/types/workflow-ui";
import { cn } from "@/lib/utils";

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

type DaprWorkflowTableProps = {
  workflows: WorkflowListItem[];
  isLoading?: boolean;
};

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
        {["1", "2", "3", "4", "5"].map((k) => (
          <TableRow key={k}>
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
        "border-gray-700 border-b",
        workflow.instanceId ? "cursor-pointer hover:bg-[#252c3d]" : "opacity-50"
      )}
      onClick={handleClick}
    >
      <TableCell>
        <Badge
          className={cn("gap-1.5", getStatusBadgeClasses(workflow.status))}
          variant={getStatusVariant(workflow.status)}
        >
          <StatusIcon status={workflow.status} />
          {workflow.status}
        </Badge>
      </TableCell>
      <TableCell>
        <Tooltip>
          <TooltipTrigger asChild>
            <span className="cursor-help font-mono text-sm text-white">
              {workflow.instanceId
                ? `${workflow.instanceId.substring(0, 20)}${workflow.instanceId.length > 20 ? "..." : ""}`
                : "-"}
            </span>
          </TooltipTrigger>
          <TooltipContent className="font-mono text-xs" side="top">
            {workflow.instanceId || "Unknown"}
          </TooltipContent>
        </Tooltip>
      </TableCell>
      <TableCell className="text-gray-400">{workflow.workflowType}</TableCell>
      <TableCell className="text-gray-400">{workflow.appId}</TableCell>
      <TableCell>
        {customStatus?.currentTask ? (
          <div className="flex flex-col gap-1">
            <span
              className="max-w-[200px] truncate text-blue-400 text-sm"
              title={customStatus.currentTask}
            >
              {customStatus.currentTask}
            </span>
            {customStatus.progress != null && workflow.status === "RUNNING" && (
              <div className="flex items-center gap-2">
                <Progress
                  className="h-1.5 w-16"
                  value={customStatus.progress}
                />
                <span className="text-gray-500 text-xs">
                  {customStatus.progress}%
                </span>
              </div>
            )}
          </div>
        ) : hasPhase ? (
          <div className="flex flex-col gap-1">
            <span
              className={cn(
                "text-sm capitalize",
                getPhaseColor(customStatus.phase)
              )}
            >
              {getPhaseLabel(customStatus.phase)}
            </span>
            {customStatus.progress != null && workflow.status === "RUNNING" && (
              <div className="flex items-center gap-2">
                <Progress
                  className="h-1.5 w-16"
                  value={customStatus.progress}
                />
                <span className="text-gray-500 text-xs">
                  {customStatus.progress}%
                </span>
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
            <span className="cursor-help text-gray-400">
              {formatTimestamp(workflow.startTime)}
            </span>
          </TooltipTrigger>
          <TooltipContent className="text-xs" side="top">
            {formatAbsoluteTimestamp(workflow.startTime)}
          </TooltipContent>
        </Tooltip>
      </TableCell>
      <TableCell>
        {workflow.status === "RUNNING" ? (
          <Tooltip>
            <TooltipTrigger asChild>
              <span className="cursor-help font-medium text-amber-400">
                {calculateDuration(workflow.startTime) || "-"}
              </span>
            </TooltipTrigger>
            <TooltipContent className="text-xs" side="top">
              Running for {calculateDuration(workflow.startTime)}
            </TooltipContent>
          </Tooltip>
        ) : workflow.endTime ? (
          <Tooltip>
            <TooltipTrigger asChild>
              <span className="cursor-help text-gray-400">
                {calculateDuration(workflow.startTime, workflow.endTime) || "-"}
              </span>
            </TooltipTrigger>
            <TooltipContent className="text-xs" side="top">
              Completed in{" "}
              {calculateDuration(workflow.startTime, workflow.endTime)}
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
      <div className="py-12 text-center text-gray-400">
        No workflow executions found
      </div>
    );
  }

  return (
    <div className="overflow-hidden rounded-lg border border-gray-700 bg-[#1a1f2e]">
      <Table>
        <TableHeader>
          <TableRow className="border-gray-700 border-b bg-[#1e2433] hover:bg-[#1e2433]">
            <TableHead className="w-32 font-medium text-gray-400">
              Status
            </TableHead>
            <TableHead className="font-medium text-gray-400">
              Instance ID
            </TableHead>
            <TableHead className="font-medium text-gray-400">Type</TableHead>
            <TableHead className="font-medium text-gray-400">App ID</TableHead>
            <TableHead className="font-medium text-gray-400">Phase</TableHead>
            <TableHead className="font-medium text-gray-400">
              Start Time
            </TableHead>
            <TableHead className="font-medium text-gray-400">
              Execution Time
            </TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {workflows.map((workflow, index) => (
            <WorkflowRow
              key={workflow.instanceId || `workflow-${index}`}
              workflow={workflow}
            />
          ))}
        </TableBody>
      </Table>
    </div>
  );
}
