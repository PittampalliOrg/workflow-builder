"use client";

import { useAtom } from "jotai";
import { useCallback, useEffect, useRef } from "react";
import { notifiedSetAtom, audioMutedAtom } from "@/lib/notifications/atoms";
import { dispatchNotification } from "@/lib/notifications/dispatch";
import { requestPermission } from "@/lib/notifications/browser-notification";

interface ActiveExecution {
  id: string;
  workflowId: string;
  workflowName: string;
  status: string;
  phase: string | null;
  approvalEventName: string | null;
}

const POLL_INTERVAL = 5000;

export function useGlobalWorkflowNotifications() {
  const [notifiedSet, setNotifiedSet] = useAtom(notifiedSetAtom);
  const [audioMuted] = useAtom(audioMutedAtom);
  const prevExecutionsRef = useRef<Map<string, ActiveExecution>>(new Map());
  const permissionRequested = useRef(false);

  // Keep a ref so checkAndNotify never goes stale but also never
  // triggers an effect restart when the set changes.
  const notifiedRef = useRef(notifiedSet);
  notifiedRef.current = notifiedSet;

  const audioMutedRef = useRef(audioMuted);
  audioMutedRef.current = audioMuted;

  const checkAndNotify = useCallback(
    (executions: ActiveExecution[]) => {
      const prev = prevExecutionsRef.current;
      const currentNotified = notifiedRef.current;
      const newNotified = new Set(currentNotified);
      let changed = false;

      for (const exec of executions) {
        const prevExec = prev.get(exec.id);
        const prevPhase = prevExec?.phase;
        const currentPhase = exec.phase;

        // Approval needed
        if (
          currentPhase === "awaiting_approval" &&
          prevPhase !== "awaiting_approval"
        ) {
          const key = `${exec.id}:approval`;
          if (!newNotified.has(key)) {
            dispatchNotification("approval", {
              executionId: exec.id,
              workflowName: exec.workflowName,
              workflowId: exec.workflowId,
            }, { muted: audioMutedRef.current });
            newNotified.add(key);
            changed = true;
          }
        }

        // Completed
        if (
          (exec.status === "success" || currentPhase === "completed") &&
          prevExec &&
          prevExec.status !== "success" &&
          prevExec.phase !== "completed"
        ) {
          const key = `${exec.id}:completed`;
          if (!newNotified.has(key)) {
            dispatchNotification("completed", {
              executionId: exec.id,
              workflowName: exec.workflowName,
              workflowId: exec.workflowId,
            }, { muted: audioMutedRef.current });
            newNotified.add(key);
            changed = true;
          }
        }

        // Error
        if (
          (exec.status === "error" || currentPhase === "failed") &&
          prevExec &&
          prevExec.status !== "error" &&
          prevExec.phase !== "failed"
        ) {
          const key = `${exec.id}:error`;
          if (!newNotified.has(key)) {
            dispatchNotification("error", {
              executionId: exec.id,
              workflowName: exec.workflowName,
              workflowId: exec.workflowId,
              message: "The workflow encountered an error.",
            }, { muted: audioMutedRef.current });
            newNotified.add(key);
            changed = true;
          }
        }
      }

      if (changed) {
        setNotifiedSet(newNotified);
      }

      // Update prev map
      const newMap = new Map<string, ActiveExecution>();
      for (const exec of executions) {
        newMap.set(exec.id, exec);
      }
      prevExecutionsRef.current = newMap;
    },
    // setNotifiedSet is stable (Jotai guarantee) — no deps that change.
    [setNotifiedSet]
  );

  useEffect(() => {
    if (!permissionRequested.current) {
      permissionRequested.current = true;
      requestPermission();
    }

    const poll = async () => {
      try {
        const res = await fetch("/api/workflow/active-executions");
        if (!res.ok) return;
        const data: ActiveExecution[] = await res.json();
        checkAndNotify(data);
      } catch {
        // Silently ignore polling errors
      }
    };

    poll();
    const interval = setInterval(poll, POLL_INTERVAL);
    return () => clearInterval(interval);
  }, [checkAndNotify]);
}
