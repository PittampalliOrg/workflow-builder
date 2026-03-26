"use client";

import { toast } from "sonner";
import { playApprovalAlert, playSuccessChime, playErrorTone } from "./audio-alerts";
import { showNotification, isPermissionGranted } from "./browser-notification";
import { startFlashing } from "./tab-title-flasher";

export type NotificationType = "approval" | "completed" | "error";

interface NotificationContext {
  executionId: string;
  workflowName?: string;
  workflowId?: string;
  message?: string;
}

export function dispatchNotification(
  type: NotificationType,
  context: NotificationContext,
  options?: { muted?: boolean }
): void {
  const name = context.workflowName || "Workflow";

  switch (type) {
    case "approval": {
      // Persistent toast
      toast.warning(`Approval needed: ${name}`, {
        duration: Number.POSITIVE_INFINITY,
        description: context.message || "A workflow is waiting for your approval.",
        action: context.workflowId
          ? {
              label: "Review",
              onClick: () => {
                window.location.href = `/workflows/${context.workflowId}`;
              },
            }
          : undefined,
        id: `approval-${context.executionId}`,
      });
      // OS notification
      if (isPermissionGranted()) {
        showNotification(`Approval Needed: ${name}`, context.message || "A workflow is waiting for your approval.", {
          tag: `approval-${context.executionId}`,
          requireInteraction: true,
          onClick: () => {
            if (context.workflowId) {
              window.location.href = `/workflows/${context.workflowId}`;
            }
          },
        });
      }
      // Audio
      if (!options?.muted) playApprovalAlert();
      // Tab title flash
      startFlashing(`[ACTION NEEDED] ${name}`);
      break;
    }
    case "completed": {
      toast.success(`Completed: ${name}`, {
        duration: 10000,
        action: context.workflowId
          ? {
              label: "View",
              onClick: () => {
                window.location.href = `/workflows/${context.workflowId}`;
              },
            }
          : undefined,
        id: `completed-${context.executionId}`,
      });
      if (isPermissionGranted()) {
        showNotification(`Workflow Completed: ${name}`, "The workflow has finished successfully.", {
          tag: `completed-${context.executionId}`,
        });
      }
      if (!options?.muted) playSuccessChime();
      startFlashing(`[COMPLETED] ${name}`);
      break;
    }
    case "error": {
      toast.error(`Error: ${name}`, {
        duration: 15000,
        description: context.message || "The workflow encountered an error.",
        action: context.workflowId
          ? {
              label: "View",
              onClick: () => {
                window.location.href = `/workflows/${context.workflowId}`;
              },
            }
          : undefined,
        id: `error-${context.executionId}`,
      });
      if (isPermissionGranted()) {
        showNotification(`Workflow Error: ${name}`, context.message || "The workflow encountered an error.", {
          tag: `error-${context.executionId}`,
        });
      }
      if (!options?.muted) playErrorTone();
      startFlashing(`[ERROR] ${name}`);
      break;
    }
  }
}
