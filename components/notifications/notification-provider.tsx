"use client";

import { useGlobalWorkflowNotifications } from "@/hooks/use-global-workflow-notifications";

export function NotificationProvider() {
  useGlobalWorkflowNotifications();
  return null;
}
