"use client";

import { useEffect } from "react";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

type ApprovalGateConfigProps = {
  config: Record<string, unknown>;
  onUpdateConfig: (key: string, value: string) => void;
  disabled?: boolean;
};

const DEFAULT_EVENT_NAME = "approval_event";
const DEFAULT_TIMEOUT_MINUTES = "5";

export function ApprovalGateConfig({
  config,
  onUpdateConfig,
  disabled,
}: ApprovalGateConfigProps) {
  // Persist defaults on mount so the orchestrator always gets them
  useEffect(() => {
    if (!config.eventName) {
      onUpdateConfig("eventName", DEFAULT_EVENT_NAME);
    }
    if (!config.timeoutMinutes && !config.timeoutHours && !config.timeoutSeconds) {
      onUpdateConfig("timeoutMinutes", DEFAULT_TIMEOUT_MINUTES);
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <>
      {/* Event Name */}
      <div className="space-y-2">
        <Label className="ml-1" htmlFor="eventName">
          Event Name
        </Label>
        <Input
          disabled={disabled}
          id="eventName"
          onChange={(e) => onUpdateConfig("eventName", e.target.value)}
          placeholder="approval_event"
          value={(config.eventName as string) || DEFAULT_EVENT_NAME}
        />
        <p className="text-muted-foreground text-xs">
          The external event name that the workflow will wait for. Use{" "}
          <code className="rounded bg-muted px-1">
            ctx.wait_for_external_event()
          </code>{" "}
          in Dapr.
        </p>
      </div>

      {/* Timeout Minutes */}
      <div className="space-y-2">
        <Label className="ml-1" htmlFor="timeoutMinutes">
          Timeout (minutes)
        </Label>
        <Input
          disabled={disabled}
          id="timeoutMinutes"
          min={1}
          max={10080}
          onChange={(e) => onUpdateConfig("timeoutMinutes", e.target.value)}
          placeholder="5"
          type="number"
          value={(config.timeoutMinutes as string) || DEFAULT_TIMEOUT_MINUTES}
        />
        <p className="text-muted-foreground text-xs">
          Maximum time to wait for approval before timing out
        </p>
      </div>

      {/* Approval Payload Schema (optional) */}
      <div className="space-y-2">
        <Label className="ml-1" htmlFor="approvalPayload">
          Approval Payload Description
        </Label>
        <Input
          disabled={disabled}
          id="approvalPayload"
          onChange={(e) => onUpdateConfig("approvalPayload", e.target.value)}
          placeholder="e.g., approved: boolean, reason?: string"
          value={(config.approvalPayload as string) || ""}
        />
        <p className="text-muted-foreground text-xs">
          Optional description of the expected approval event payload
        </p>
      </div>
    </>
  );
}
