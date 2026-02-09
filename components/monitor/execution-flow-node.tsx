"use client";

/**
 * ExecutionFlowNode Component
 *
 * Custom React Flow node for execution events.
 * Styled to match Diagrid's cyan/teal rounded rectangle design.
 */

import { Handle, type NodeProps, Position } from "@xyflow/react";
import { memo } from "react";
import type { ExecutionFlowNode as ExecutionFlowNodeType } from "@/lib/types/execution-graph";
import { cn } from "@/lib/utils";

// ============================================================================
// Main Component
// ============================================================================

function ExecutionFlowNodeComponent({
  data,
  selected,
}: NodeProps<ExecutionFlowNodeType>) {
  // Diagrid uses consistent teal/cyan styling for all nodes
  const borderColor = "#2dd4bf"; // teal-400
  const bgColor = "rgba(45, 212, 191, 0.1)"; // teal with low opacity

  // Default to showing both handles if handles config is not provided
  const showTargetHandle = data.handles?.target !== false;
  const showSourceHandle = data.handles?.source !== false;

  return (
    <>
      {/* Target handle (top) - for vertical layout */}
      {showTargetHandle && (
        <Handle
          className="!w-2 !h-2 !bg-teal-400 !border-0 !-top-1"
          position={Position.Top}
          type="target"
        />
      )}

      {/* Node content - Diagrid style */}
      <div
        className={cn(
          "relative min-w-[200px] rounded-full border-2 px-6 py-3 transition-all duration-200",
          "cursor-pointer text-center",
          selected &&
            "ring-2 ring-teal-400 ring-offset-2 ring-offset-background"
        )}
        style={{
          backgroundColor: bgColor,
          borderColor,
        }}
      >
        <span className="font-medium text-sm text-white">
          {data.name || data.eventType || "Event"}
        </span>
      </div>

      {/* Source handle (bottom) - for vertical layout */}
      {showSourceHandle && (
        <Handle
          className="!w-2 !h-2 !bg-teal-400 !border-0 !-bottom-1"
          position={Position.Bottom}
          type="source"
        />
      )}
    </>
  );
}

export const ExecutionFlowNode = memo(ExecutionFlowNodeComponent);
