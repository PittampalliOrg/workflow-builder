"use client";

import { Check, Circle, Radio, WifiOff } from "lucide-react";
import { useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { formatDateTime } from "@/lib/transforms/workflow-ui";
import {
  getPhaseColor,
  getPhaseLabel,
  getStatusVariant,
  type WorkflowDetail,
} from "@/lib/types/workflow-ui";
import { cn } from "@/lib/utils";

type WorkflowDetailHeaderProps = {
  workflow: WorkflowDetail;
};

export function WorkflowDetailHeader({ workflow }: WorkflowDetailHeaderProps) {
  const [copied, setCopied] = useState(false);

  const handleCopyInstanceId = async () => {
    try {
      await navigator.clipboard.writeText(workflow.instanceId);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (err) {
      console.error("Failed to copy:", err);
    }
  };

  return (
    <div className="space-y-4">
      {/* Instance ID row - Diagrid style */}
      <div className="flex items-center gap-3">
        <span className="text-gray-400 text-sm">INSTANCE ID:</span>
        <code className="font-mono text-sm text-white">
          {workflow.instanceId}
        </code>
        <Button
          className="h-auto px-0 py-0 text-teal-400 hover:bg-transparent hover:text-teal-300"
          onClick={handleCopyInstanceId}
          size="sm"
          variant="ghost"
        >
          {copied ? (
            <span className="flex items-center gap-1">
              <Check className="h-3.5 w-3.5" />
              Copied
            </span>
          ) : (
            "Copy"
          )}
        </Button>
      </div>

      {/* Metadata bar - Diagrid style with vertical layout */}
      <div className="flex flex-wrap gap-8 rounded-lg border border-gray-700 bg-[#1e2433] px-5 py-4">
        {/* Status */}
        <div className="flex flex-col gap-1">
          <span className="text-gray-500 text-xs uppercase tracking-wide">
            Status
          </span>
          <div className="flex items-center gap-2">
            <Badge
              className={cn(
                "w-fit gap-1",
                workflow.status === "COMPLETED" &&
                  "bg-green-600 hover:bg-green-700",
                workflow.status === "RUNNING" &&
                  "bg-amber-500 hover:bg-amber-600",
                workflow.status === "FAILED" && "bg-red-600 hover:bg-red-700"
              )}
              variant={getStatusVariant(workflow.status)}
            >
              {workflow.status === "COMPLETED" && <Check className="h-3 w-3" />}
              {workflow.status === "RUNNING" && (
                <Circle className="h-2 w-2 animate-pulse fill-current" />
              )}
              {workflow.status}
            </Badge>
            {/* Dapr Live Status Indicator */}
            <TooltipProvider>
              <Tooltip>
                <TooltipTrigger asChild>
                  <div className="flex items-center">
                    {workflow.daprStatus?.runtimeStatus &&
                    workflow.daprStatus.runtimeStatus !== "UNKNOWN" ? (
                      <Badge
                        className="gap-1 border-teal-500/50 bg-teal-500/10 text-teal-400 text-xs"
                        variant="outline"
                      >
                        <Radio className="h-2.5 w-2.5 animate-pulse" />
                        Live
                      </Badge>
                    ) : (
                      <Badge
                        className="gap-1 border-gray-600 bg-gray-800/50 text-gray-500 text-xs"
                        variant="outline"
                      >
                        <WifiOff className="h-2.5 w-2.5" />
                        DB
                      </Badge>
                    )}
                  </div>
                </TooltipTrigger>
                <TooltipContent className="max-w-xs" side="bottom">
                  {workflow.daprStatus?.runtimeStatus &&
                  workflow.daprStatus.runtimeStatus !== "UNKNOWN" ? (
                    <div className="space-y-1">
                      <p className="font-medium text-teal-400">
                        Live from Dapr Runtime
                      </p>
                      <p className="text-gray-400 text-xs">
                        Status: {workflow.daprStatus.runtimeStatus}
                      </p>
                      {workflow.daprStatus.currentNodeName && (
                        <p className="text-gray-400 text-xs">
                          Current: {workflow.daprStatus.currentNodeName}
                        </p>
                      )}
                    </div>
                  ) : (
                    <div className="space-y-1">
                      <p className="font-medium text-gray-300">From Database</p>
                      <p className="text-gray-400 text-xs">
                        Dapr workflow not found (may be purged after completion)
                      </p>
                    </div>
                  )}
                </TooltipContent>
              </Tooltip>
            </TooltipProvider>
          </div>
        </div>

        {/* Phase (for planner-agent workflows) */}
        {workflow.customStatus?.phase && (
          <div className="flex flex-col gap-1">
            <span className="text-gray-500 text-xs uppercase tracking-wide">
              Phase
            </span>
            <span
              className={cn(
                "font-medium text-sm capitalize",
                getPhaseColor(workflow.customStatus.phase)
              )}
            >
              {getPhaseLabel(workflow.customStatus.phase)}
            </span>
          </div>
        )}

        {/* Progress (for running planner-agent workflows) */}
        {workflow.customStatus?.progress != null &&
          workflow.status === "RUNNING" && (
            <div className="flex flex-col gap-1">
              <span className="text-gray-500 text-xs uppercase tracking-wide">
                Progress
              </span>
              <div className="flex items-center gap-2">
                <Progress
                  className="h-2 w-24"
                  value={workflow.customStatus.progress}
                />
                <span className="font-medium text-sm text-white">
                  {workflow.customStatus.progress}%
                </span>
              </div>
            </div>
          )}

        {/* App ID */}
        <div className="flex flex-col gap-1">
          <span className="text-gray-500 text-xs uppercase tracking-wide">
            App ID
          </span>
          <span className="font-medium text-sm text-white">
            {workflow.appId}
          </span>
        </div>

        {/* Workflow Type */}
        <div className="flex flex-col gap-1">
          <span className="text-gray-500 text-xs uppercase tracking-wide">
            Type
          </span>
          <span className="font-medium text-sm text-white">
            {workflow.workflowType}
          </span>
        </div>

        {/* Start Time */}
        <div className="flex flex-col gap-1">
          <span className="text-gray-500 text-xs uppercase tracking-wide">
            Start
          </span>
          <span className="font-medium text-sm text-white">
            {formatDateTime(workflow.startTime)}
          </span>
        </div>

        {/* End Time */}
        <div className="flex flex-col gap-1">
          <span className="text-gray-500 text-xs uppercase tracking-wide">
            End
          </span>
          <span className="font-medium text-sm text-white">
            {workflow.endTime ? formatDateTime(workflow.endTime) : "-"}
          </span>
        </div>

        {/* Duration */}
        <div className="flex flex-col gap-1">
          <span className="text-gray-500 text-xs uppercase tracking-wide">
            Duration
          </span>
          <span className="font-medium text-sm text-white">
            {workflow.executionDuration || "-"}
          </span>
        </div>
      </div>

      {/* Current Node (when running with Dapr status) */}
      {workflow.status === "RUNNING" &&
        workflow.daprStatus?.currentNodeName && (
          <div className="rounded-lg border border-teal-500/30 bg-teal-500/5 px-4 py-3">
            <div className="flex items-center gap-2">
              <Circle className="h-2 w-2 animate-pulse fill-teal-400 text-teal-400" />
              <span className="text-gray-400 text-xs uppercase">
                Currently Executing:
              </span>
              <span className="font-medium text-sm text-teal-400">
                {workflow.daprStatus.currentNodeName}
              </span>
            </div>
          </div>
        )}

      {/* Message (for planner-agent workflows with custom status) */}
      {workflow.customStatus?.message && (
        <div className="rounded-lg border border-gray-700 bg-[#1e2433]/50 px-4 py-3">
          <span className="text-gray-300 text-sm">
            {workflow.customStatus.message}
          </span>
        </div>
      )}

      {/* Dapr Error (if present) */}
      {workflow.daprStatus?.error && (
        <div className="rounded-lg border border-red-500/30 bg-red-500/5 px-4 py-3">
          <div className="flex items-start gap-2">
            <span className="font-medium text-red-400 text-xs uppercase">
              Dapr Error:
            </span>
            <span className="text-red-300 text-sm">
              {workflow.daprStatus.error}
            </span>
          </div>
        </div>
      )}
    </div>
  );
}
