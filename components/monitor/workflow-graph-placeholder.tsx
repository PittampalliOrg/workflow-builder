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

interface WorkflowGraphPlaceholderProps {
  workflowName: string;
}

// ============================================================================
// Component
// ============================================================================

export function WorkflowGraphPlaceholder({
  workflowName,
}: WorkflowGraphPlaceholderProps) {
  return (
    <Card className="h-full min-h-[400px]">
      <CardContent className="flex flex-col items-center justify-center h-full py-16">
        <div className="rounded-full bg-muted p-6 mb-4">
          <GitBranch className="h-12 w-12 text-muted-foreground" />
        </div>
        <h3 className="text-lg font-medium mb-2">Workflow Graph</h3>
        <p className="text-sm text-muted-foreground text-center max-w-md">
          Visual representation of <span className="font-mono">{workflowName}</span> workflow execution graph will be available in a future update.
        </p>
        <div className="mt-6 px-4 py-2 rounded-md bg-muted/50 border">
          <p className="text-xs text-muted-foreground">
            Planned: React Flow integration
          </p>
        </div>
      </CardContent>
    </Card>
  );
}
