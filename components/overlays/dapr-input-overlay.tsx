"use client";

import { useState } from "react";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Overlay } from "./overlay";
import { useOverlay } from "./overlay-provider";
import type { OverlayComponentProps } from "./types";

export type DaprWorkflowInput = {
  feature_request: string;
  cwd: string;
};

type DaprInputOverlayProps = OverlayComponentProps<{
  onRun: (input: DaprWorkflowInput) => void;
}>;

export function DaprInputOverlay({ overlayId, onRun }: DaprInputOverlayProps) {
  const { closeAll } = useOverlay();
  const [featureRequest, setFeatureRequest] = useState("");
  const [cwd, setCwd] = useState("/workspace");

  const handleRun = () => {
    closeAll();
    onRun({
      feature_request: featureRequest,
      cwd,
    });
  };

  const isValid = featureRequest.trim().length > 0;

  return (
    <Overlay
      actions={[
        {
          label: "Run Workflow",
          variant: "default",
          onClick: handleRun,
          disabled: !isValid,
        },
        { label: "Cancel", onClick: closeAll },
      ]}
      overlayId={overlayId}
      title="Run Dapr Workflow"
    >
      <p className="text-muted-foreground text-sm">
        Provide input for the Dapr workflow orchestrator.
      </p>

      <div className="mt-4 space-y-4">
        {/* Feature Request */}
        <div className="space-y-2">
          <Label htmlFor="featureRequest">
            Feature Request <span className="text-red-500">*</span>
          </Label>
          <textarea
            className="flex min-h-[80px] w-full resize-none rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50"
            id="featureRequest"
            onChange={(e) => setFeatureRequest(e.target.value)}
            placeholder="Describe the feature to plan and implement..."
            rows={4}
            value={featureRequest}
          />
          <p className="text-muted-foreground text-xs">
            The feature description that will be sent to the planning agent.
          </p>
        </div>

        {/* Working Directory */}
        <div className="space-y-2">
          <Label htmlFor="cwd">Working Directory</Label>
          <Input
            id="cwd"
            onChange={(e) => setCwd(e.target.value)}
            placeholder="/workspace"
            value={cwd}
          />
          <p className="text-muted-foreground text-xs">
            The working directory for the agent (default: /workspace).
          </p>
        </div>
      </div>
    </Overlay>
  );
}
