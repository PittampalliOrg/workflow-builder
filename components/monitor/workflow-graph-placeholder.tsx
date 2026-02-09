"use client";

/**
 * WorkflowGraphPlaceholder Component
 *
 * Placeholder for the workflow graph visualization.
 * Will be replaced with React Flow implementation in the future.
 */

import { GitBranch } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";

// ============================================================================
// Types
// ============================================================================

type WorkflowGraphPlaceholderProps = {
  workflowName: string;
};

// ============================================================================
// Component
// ============================================================================

export function WorkflowGraphPlaceholder({
  workflowName,
}: WorkflowGraphPlaceholderProps) {
  return (
    <Card className="h-full min-h-[400px]">
      <CardContent className="flex h-full flex-col items-center justify-center py-16">
        <div className="mb-4 rounded-full bg-muted p-6">
          <GitBranch className="h-12 w-12 text-muted-foreground" />
        </div>
        <h3 className="mb-2 font-medium text-lg">Workflow Graph</h3>
        <p className="max-w-md text-center text-muted-foreground text-sm">
          Visual representation of{" "}
          <span className="font-mono">{workflowName}</span> workflow execution
          graph will be available in a future update.
        </p>
        <div className="mt-6 rounded-md border bg-muted/50 px-4 py-2">
          <p className="text-muted-foreground text-xs">
            Planned: React Flow integration
          </p>
        </div>
      </CardContent>
    </Card>
  );
}
