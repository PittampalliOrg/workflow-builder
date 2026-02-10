"use client";

import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

type ApprovalGateConfigProps = {
  config: Record<string, unknown>;
  onUpdateConfig: (key: string, value: string) => void;
  disabled?: boolean;
};

export function ApprovalGateConfig({
  config,
  onUpdateConfig,
  disabled,
}: ApprovalGateConfigProps) {
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
          value={(config.eventName as string) || "approval_event"}
        />
        <p className="text-muted-foreground text-xs">
          The external event name that the workflow will wait for. Use{" "}
          <code className="rounded bg-muted px-1">
            ctx.wait_for_external_event()
          </code>{" "}
          in Dapr.
        </p>
      </div>

      {/* Timeout Hours */}
      <div className="space-y-2">
        <Label className="ml-1" htmlFor="timeoutHours">
          Timeout (hours)
        </Label>
        <Input
          disabled={disabled}
          id="timeoutHours"
          max={168}
          min={1}
          onChange={(e) => onUpdateConfig("timeoutHours", e.target.value)}
          placeholder="24"
          type="number"
          value={(config.timeoutHours as string) || "24"}
        />
        <p className="text-muted-foreground text-xs">
          Maximum time to wait for approval before timing out (1-168 hours)
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
