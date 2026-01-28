"use client";

import type { NodeProps } from "@xyflow/react";
import { useAtomValue } from "jotai";
import { Check, Cpu, XCircle } from "lucide-react";
import { memo } from "react";
import {
  Node,
  NodeDescription,
  NodeTitle,
} from "@/components/ai-elements/node";
import { cn } from "@/lib/utils";
import {
  executionLogsAtom,
  selectedExecutionIdAtom,
  type WorkflowNodeData,
} from "@/lib/workflow-store";
import { getDaprActivity } from "@/lib/dapr-activity-registry";

const StatusBadge = ({
  status,
}: {
  status?: "idle" | "running" | "success" | "error";
}) => {
  if (!status || status === "idle" || status === "running") {
    return null;
  }

  return (
    <div
      className={cn(
        "absolute top-2 right-2 rounded-full p-1",
        status === "success" && "bg-green-500/50",
        status === "error" && "bg-red-500/50"
      )}
    >
      {status === "success" && (
        <Check className="size-3.5 text-white" strokeWidth={2.5} />
      )}
      {status === "error" && (
        <XCircle className="size-3.5 text-white" strokeWidth={2.5} />
      )}
    </div>
  );
};

type ActivityNodeProps = NodeProps & {
  data?: WorkflowNodeData;
  id: string;
};

export const ActivityNode = memo(
  ({ data, selected, id }: ActivityNodeProps) => {
    const selectedExecutionId = useAtomValue(selectedExecutionIdAtom);
    const executionLogs = useAtomValue(executionLogsAtom);

    if (!data) {
      return null;
    }

    const activityName = (data.config?.activityName as string) || "";
    const activity = activityName ? getDaprActivity(activityName) : undefined;
    const displayTitle = data.label || activity?.label || "Activity";
    const displayDescription =
      data.description || activity?.category || "Dapr Activity";
    const status = data.status;

    // Show timeout if configured
    const timeout = (data.config?.timeout as number) || activity?.timeout;

    return (
      <Node
        className={cn(
          "relative flex h-48 w-48 flex-col items-center justify-center shadow-none transition-all duration-150 ease-out",
          selected && "border-primary"
        )}
        data-testid={`activity-node-${id}`}
        handles={{ target: true, source: true }}
        status={status}
      >
        <StatusBadge status={status} />

        <div className="flex flex-col items-center justify-center gap-3 p-6">
          <Cpu className="size-12 text-blue-400" strokeWidth={1.5} />
          <div className="flex flex-col items-center gap-1 text-center">
            <NodeTitle className="text-base">{displayTitle}</NodeTitle>
            <NodeDescription className="text-xs">
              {displayDescription}
            </NodeDescription>
            {timeout && (
              <div className="rounded-full border border-muted-foreground/50 px-2 py-0.5 font-medium text-[10px] text-muted-foreground">
                {timeout}s timeout
              </div>
            )}
          </div>
        </div>
      </Node>
    );
  }
);

ActivityNode.displayName = "ActivityNode";
