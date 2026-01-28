"use client";

import { useAtom, useSetAtom } from "jotai";
import { Check, Loader2, ShieldCheck, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { api } from "@/lib/api-client";
import {
  daprInstanceIdAtom,
  daprMessageAtom,
  daprPhaseAtom,
  daprProgressAtom,
  type DaprPhase,
  nodesAtom,
  updateNodeDataAtom,
} from "@/lib/workflow-store";

type SSEEvent = {
  type: "status" | "complete" | "error";
  daprStatus?: string;
  phase?: string;
  progress?: number;
  message?: string;
  currentActivity?: string;
};

// Map Dapr phases to display labels
const PHASE_LABELS: Record<string, string> = {
  planning: "Planning...",
  persisting: "Saving tasks...",
  awaiting_approval: "Awaiting approval",
  executing: "Executing...",
  completed: "Completed",
  failed: "Failed",
};

type DaprWorkflowMonitorProps = {
  executionId: string;
  onComplete?: () => void;
};

export function DaprWorkflowMonitor({
  executionId,
  onComplete,
}: DaprWorkflowMonitorProps) {
  const [phase, setPhase] = useAtom(daprPhaseAtom);
  const [progress, setProgress] = useAtom(daprProgressAtom);
  const [message, setMessage] = useAtom(daprMessageAtom);
  const setInstanceId = useSetAtom(daprInstanceIdAtom);
  const updateNodeData = useSetAtom(updateNodeDataAtom);
  const [nodes] = useAtom(nodesAtom);
  const [isApproving, setIsApproving] = useState(false);
  const eventSourceRef = useRef<EventSource | null>(null);

  // Map phases to node status updates
  const updateNodeStatuses = useCallback(
    (currentPhase: string, currentActivity?: string) => {
      // Find nodes by type and update their status based on phase
      for (const node of nodes) {
        if (node.type === "activity") {
          const activityName = node.data.config?.activityName as
            | string
            | undefined;
          if (activityName === currentActivity) {
            updateNodeData({
              id: node.id,
              data: { status: "running" },
            });
          } else if (
            currentPhase === "completed" ||
            currentPhase === "failed"
          ) {
            // Mark all as idle on completion
            updateNodeData({
              id: node.id,
              data: {
                status:
                  currentPhase === "completed" ? "success" : "idle",
              },
            });
          }
        } else if (node.type === "approval-gate") {
          if (currentPhase === "awaiting_approval") {
            updateNodeData({
              id: node.id,
              data: { status: "running" },
            });
          } else if (currentPhase === "executing" || currentPhase === "completed") {
            updateNodeData({
              id: node.id,
              data: { status: "success" },
            });
          }
        }
      }
    },
    [nodes, updateNodeData]
  );

  // Connect to SSE event stream
  useEffect(() => {
    if (!executionId) return;

    const eventSource = new EventSource(
      `/api/dapr/workflows/${executionId}/events`
    );
    eventSourceRef.current = eventSource;

    eventSource.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data) as SSEEvent;

        if (data.type === "status") {
          const newPhase = (data.phase || null) as DaprPhase;
          setPhase(newPhase);
          setProgress(data.progress || 0);
          setMessage(data.message || "");
          updateNodeStatuses(data.phase || "", data.currentActivity);
        } else if (data.type === "complete") {
          const finalPhase = (data.daprStatus === "COMPLETED"
            ? "completed"
            : "failed") as DaprPhase;
          setPhase(finalPhase);
          setProgress(data.progress || 100);
          setMessage(data.message || "");
          updateNodeStatuses(finalPhase || "");
          onComplete?.();
          eventSource.close();
        } else if (data.type === "error") {
          toast.error(data.message || "Workflow error");
        }
      } catch {
        // Ignore parse errors
      }
    };

    eventSource.onerror = () => {
      eventSource.close();
    };

    return () => {
      eventSource.close();
    };
  }, [
    executionId,
    setPhase,
    setProgress,
    setMessage,
    setInstanceId,
    updateNodeStatuses,
    onComplete,
  ]);

  const handleApprove = async (approved: boolean) => {
    setIsApproving(true);
    try {
      await api.dapr.approve(executionId, approved);
      toast.success(
        approved ? "Workflow approved" : "Workflow rejected"
      );
    } catch (error) {
      toast.error(
        error instanceof Error
          ? error.message
          : "Failed to process approval"
      );
    } finally {
      setIsApproving(false);
    }
  };

  const phaseLabel =
    PHASE_LABELS[phase || ""] || phase || "Initializing...";
  const isComplete = phase === "completed" || phase === "failed";

  return (
    <div className="space-y-3 rounded-lg border p-4">
      {/* Phase indicator */}
      <div className="flex items-center gap-2">
        {!isComplete && (
          <Loader2 className="size-4 animate-spin text-muted-foreground" />
        )}
        {phase === "completed" && (
          <Check className="size-4 text-green-500" />
        )}
        {phase === "failed" && <X className="size-4 text-red-500" />}
        <span className="font-medium text-sm">{phaseLabel}</span>
      </div>

      {/* Progress bar */}
      {!isComplete && (
        <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
          <div
            className="h-full rounded-full bg-primary transition-all duration-500"
            style={{ width: `${progress}%` }}
          />
        </div>
      )}

      {/* Status message */}
      {message && (
        <p className="text-muted-foreground text-xs">{message}</p>
      )}

      {/* Approval buttons */}
      {phase === "awaiting_approval" && (
        <div className="flex items-center gap-2 pt-2">
          <ShieldCheck className="size-4 text-amber-400" />
          <span className="text-sm">Plan review required</span>
          <div className="ml-auto flex gap-2">
            <Button
              disabled={isApproving}
              onClick={() => handleApprove(false)}
              size="sm"
              variant="outline"
            >
              <X className="mr-1 size-3" />
              Reject
            </Button>
            <Button
              disabled={isApproving}
              onClick={() => handleApprove(true)}
              size="sm"
            >
              <Check className="mr-1 size-3" />
              Approve
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
