"use client";

import type { NodeProps } from "@xyflow/react";
import { useAtomValue } from "jotai";
import { Check, Clock, ShieldCheck, XCircle } from "lucide-react";
import { memo } from "react";
import {
  Node,
  NodeDescription,
  NodeTitle,
} from "@/components/ai-elements/node";
import { cn } from "@/lib/utils";
import { daprPhaseAtom, type WorkflowNodeData } from "@/lib/workflow-store";

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

type ApprovalGateNodeProps = NodeProps & {
  data?: WorkflowNodeData;
  id: string;
};

export const ApprovalGateNode = memo(
  ({ data, selected, id }: ApprovalGateNodeProps) => {
    const daprPhase = useAtomValue(daprPhaseAtom);

    if (!data) {
      return null;
    }

    const eventName = (data.config?.eventName as string) || "approval_event";
    const timeoutHours = (data.config?.timeoutHours as number) || 24;
    const displayTitle = data.label || "Approval Gate";
    const displayDescription = data.description || `Wait for ${eventName}`;
    const status = data.status;

    const isWaitingForApproval = daprPhase === "awaiting_approval";

    return (
      <Node
        className={cn(
          "relative flex h-48 w-48 flex-col items-center justify-center shadow-none transition-all duration-150 ease-out",
          selected && "border-primary",
          isWaitingForApproval && "border-amber-400"
        )}
        data-testid={`approval-gate-node-${id}`}
        handles={{ target: true, source: true }}
        status={isWaitingForApproval ? "running" : status}
      >
        <StatusBadge status={status} />

        <div className="flex flex-col items-center justify-center gap-3 p-6">
          <ShieldCheck
            className={cn(
              "strokeWidth-[1.5] size-12",
              isWaitingForApproval ? "text-amber-400" : "text-amber-300"
            )}
            strokeWidth={1.5}
          />
          <div className="flex flex-col items-center gap-1 text-center">
            <NodeTitle className="text-base">{displayTitle}</NodeTitle>
            <NodeDescription className="text-xs">
              {displayDescription}
            </NodeDescription>
            <div className="flex items-center gap-1 rounded-full border border-muted-foreground/50 px-2 py-0.5 font-medium text-[10px] text-muted-foreground">
              <Clock className="size-3" />
              {timeoutHours}h timeout
            </div>
          </div>
        </div>
      </Node>
    );
  }
);

ApprovalGateNode.displayName = "ApprovalGateNode";
