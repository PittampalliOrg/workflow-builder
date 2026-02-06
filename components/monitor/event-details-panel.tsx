"use client";

/**
 * EventDetailsPanel Component
 *
 * Side panel for displaying selected event details.
 * Matches Diagrid Catalyst style with prominent Input/Output panels.
 */

import { X, Info, Copy, Check } from "lucide-react";
import { useState } from "react";
import type { DaprExecutionEvent } from "@/lib/types/workflow-ui";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { SyntaxHighlightedJson } from "./json-panel";

// ============================================================================
// Types
// ============================================================================

interface EventDetailsPanelProps {
  event: DaprExecutionEvent;
  onClose: () => void;
}

// ============================================================================
// Helper Components
// ============================================================================

interface JsonPanelProps {
  title: string;
  data: unknown;
}

function JsonPanel({ title, data }: JsonPanelProps) {
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(JSON.stringify(data, null, 2));
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (err) {
      console.error("Failed to copy:", err);
    }
  };

  const hasData = data !== undefined && data !== null;

  return (
    <div className="border border-border/50 rounded-lg overflow-hidden bg-[#1e2433]">
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-2 border-b border-gray-700">
        <span className="text-sm font-medium text-gray-300">{title}</span>
        {hasData && (
          <Button
            variant="ghost"
            size="sm"
            className="h-6 px-2 text-xs text-teal-400 hover:text-teal-300 hover:bg-transparent"
            onClick={handleCopy}
          >
            {copied ? (
              <>
                <Check className="h-3 w-3 mr-1" />
                Copied
              </>
            ) : (
              <>
                <Copy className="h-3 w-3 mr-1" />
                Copy
              </>
            )}
          </Button>
        )}
      </div>
      {/* Content with syntax highlighting */}
      <div className="p-3 max-h-48 overflow-auto">
        {hasData ? (
          <SyntaxHighlightedJson data={data} />
        ) : (
          <p className="text-xs text-muted-foreground italic">No data</p>
        )}
      </div>
    </div>
  );
}

// ============================================================================
// Main Component
// ============================================================================

export function EventDetailsPanel({ event, onClose }: EventDetailsPanelProps) {
  // Calculate execution time if we have metadata
  const executionTime = event.metadata?.executionDuration || event.metadata?.elapsed;

  return (
    <div className="h-full flex flex-col bg-card border-l min-w-[320px]">
      {/* Header - Activity name with close button */}
      <div className="flex items-start justify-between px-4 py-3 border-b">
        <div className="flex-1 min-w-0">
          <h3 className="font-semibold text-foreground text-lg truncate">
            {event.name || event.eventType}
          </h3>
          {/* Type Badge */}
          <div className="mt-1">
            <Badge
              variant="outline"
              className="text-xs bg-teal-500/10 text-teal-400 border-teal-500/30"
            >
              {event.eventType === "TaskCompleted" || event.eventType === "TaskScheduled"
                ? "activity"
                : event.eventType.toLowerCase().replace("orchestrator", "").replace("execution", "")}
            </Badge>
          </div>
        </div>
        <Button
          variant="ghost"
          size="icon"
          className="h-8 w-8 shrink-0"
          onClick={onClose}
        >
          <X className="h-4 w-4" />
          <span className="sr-only">Close</span>
        </Button>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-auto p-4 space-y-4">
        {/* Execution Time - Prominent like Diagrid */}
        {executionTime && (
          <div className="flex items-center gap-2 text-sm">
            <span className="text-muted-foreground">Execution time:</span>
            <span className="font-semibold text-foreground">{executionTime}</span>
            <Info className="h-3.5 w-3.5 text-muted-foreground" />
          </div>
        )}

        {/* Input Panel - Always visible */}
        <JsonPanel title="Input" data={event.input} />

        {/* Output Panel - Always visible */}
        <JsonPanel title="Output" data={event.output} />
      </div>
    </div>
  );
}
