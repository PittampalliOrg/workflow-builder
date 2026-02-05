"use client";

import { useState } from "react";
import { Check, Circle, Radio, Wifi, WifiOff } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  getStatusVariant,
  getPhaseLabel,
  getPhaseColor,
  type WorkflowDetail,
} from "@/lib/types/workflow-ui";
import { formatDateTime } from "@/lib/transforms/workflow-ui";
import { Progress } from "@/components/ui/progress";

interface WorkflowDetailHeaderProps {
  workflow: WorkflowDetail;
}

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
        <span className="text-sm text-gray-400">INSTANCE ID:</span>
        <code className="font-mono text-sm text-white">
          {workflow.instanceId}
        </code>
        <Button
          variant="ghost"
          size="sm"
          className="h-auto py-0 px-0 text-teal-400 hover:text-teal-300 hover:bg-transparent"
          onClick={handleCopyInstanceId}
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
      <div className="flex flex-wrap gap-8 py-4 px-5 rounded-lg border border-gray-700 bg-[#1e2433]">
        {/* Status */}
        <div className="flex flex-col gap-1">
          <span className="text-xs text-gray-500 uppercase tracking-wide">Status</span>
          <div className="flex items-center gap-2">
            <Badge
              variant={getStatusVariant(workflow.status)}
              className={cn(
                "gap-1 w-fit",
                workflow.status === "COMPLETED" && "bg-green-600 hover:bg-green-700",
                workflow.status === "RUNNING" && "bg-amber-500 hover:bg-amber-600",
                workflow.status === "FAILED" && "bg-red-600 hover:bg-red-700"
              )}
            >
              {workflow.status === "COMPLETED" && (
                <Check className="h-3 w-3" />
              )}
              {workflow.status === "RUNNING" && (
                <Circle className="h-2 w-2 fill-current animate-pulse" />
              )}
              {workflow.status}
            </Badge>
            {/* Dapr Live Status Indicator */}
            <TooltipProvider>
              <Tooltip>
                <TooltipTrigger asChild>
                  <div className="flex items-center">
                    {workflow.daprStatus?.runtimeStatus && workflow.daprStatus.runtimeStatus !== "UNKNOWN" ? (
                      <Badge variant="outline" className="gap-1 text-xs border-teal-500/50 text-teal-400 bg-teal-500/10">
                        <Radio className="h-2.5 w-2.5 animate-pulse" />
                        Live
                      </Badge>
                    ) : (
                      <Badge variant="outline" className="gap-1 text-xs border-gray-600 text-gray-500 bg-gray-800/50">
                        <WifiOff className="h-2.5 w-2.5" />
                        DB
                      </Badge>
                    )}
                  </div>
                </TooltipTrigger>
                <TooltipContent side="bottom" className="max-w-xs">
                  {workflow.daprStatus?.runtimeStatus && workflow.daprStatus.runtimeStatus !== "UNKNOWN" ? (
                    <div className="space-y-1">
                      <p className="font-medium text-teal-400">Live from Dapr Runtime</p>
                      <p className="text-xs text-gray-400">
                        Status: {workflow.daprStatus.runtimeStatus}
                      </p>
                      {workflow.daprStatus.currentNodeName && (
                        <p className="text-xs text-gray-400">
                          Current: {workflow.daprStatus.currentNodeName}
                        </p>
                      )}
                    </div>
                  ) : (
                    <div className="space-y-1">
                      <p className="font-medium text-gray-300">From Database</p>
                      <p className="text-xs text-gray-400">
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
            <span className="text-xs text-gray-500 uppercase tracking-wide">Phase</span>
            <span className={cn("text-sm font-medium capitalize", getPhaseColor(workflow.customStatus.phase))}>
              {getPhaseLabel(workflow.customStatus.phase)}
            </span>
          </div>
        )}

        {/* Progress (for running planner-agent workflows) */}
        {workflow.customStatus?.progress != null && workflow.status === "RUNNING" && (
          <div className="flex flex-col gap-1">
            <span className="text-xs text-gray-500 uppercase tracking-wide">Progress</span>
            <div className="flex items-center gap-2">
              <Progress value={workflow.customStatus.progress} className="h-2 w-24" />
              <span className="text-sm font-medium text-white">
                {workflow.customStatus.progress}%
              </span>
            </div>
          </div>
        )}

        {/* App ID */}
        <div className="flex flex-col gap-1">
          <span className="text-xs text-gray-500 uppercase tracking-wide">App ID</span>
          <span className="text-sm font-medium text-white">{workflow.appId}</span>
        </div>

        {/* Workflow Type */}
        <div className="flex flex-col gap-1">
          <span className="text-xs text-gray-500 uppercase tracking-wide">Type</span>
          <span className="text-sm font-medium text-white">{workflow.workflowType}</span>
        </div>

        {/* Start Time */}
        <div className="flex flex-col gap-1">
          <span className="text-xs text-gray-500 uppercase tracking-wide">Start</span>
          <span className="text-sm font-medium text-white">
            {formatDateTime(workflow.startTime)}
          </span>
        </div>

        {/* End Time */}
        <div className="flex flex-col gap-1">
          <span className="text-xs text-gray-500 uppercase tracking-wide">End</span>
          <span className="text-sm font-medium text-white">
            {workflow.endTime ? formatDateTime(workflow.endTime) : "-"}
          </span>
        </div>

        {/* Duration */}
        <div className="flex flex-col gap-1">
          <span className="text-xs text-gray-500 uppercase tracking-wide">Duration</span>
          <span className="text-sm font-medium text-white">
            {workflow.executionDuration || "-"}
          </span>
        </div>
      </div>

      {/* Current Node (when running with Dapr status) */}
      {workflow.status === "RUNNING" && workflow.daprStatus?.currentNodeName && (
        <div className="py-3 px-4 rounded-lg border border-teal-500/30 bg-teal-500/5">
          <div className="flex items-center gap-2">
            <Circle className="h-2 w-2 fill-teal-400 text-teal-400 animate-pulse" />
            <span className="text-xs text-gray-400 uppercase">Currently Executing:</span>
            <span className="text-sm font-medium text-teal-400">
              {workflow.daprStatus.currentNodeName}
            </span>
          </div>
        </div>
      )}

      {/* Message (for planner-agent workflows with custom status) */}
      {workflow.customStatus?.message && (
        <div className="py-3 px-4 rounded-lg border border-gray-700 bg-[#1e2433]/50">
          <span className="text-sm text-gray-300">{workflow.customStatus.message}</span>
        </div>
      )}

      {/* Dapr Error (if present) */}
      {workflow.daprStatus?.error && (
        <div className="py-3 px-4 rounded-lg border border-red-500/30 bg-red-500/5">
          <div className="flex items-start gap-2">
            <span className="text-xs text-red-400 uppercase font-medium">Dapr Error:</span>
            <span className="text-sm text-red-300">{workflow.daprStatus.error}</span>
          </div>
        </div>
      )}
    </div>
  );
}
