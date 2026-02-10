"use client";

/**
 * EventDetailsPanel Component
 *
 * Side panel for displaying selected event details.
 * Matches Diagrid Catalyst style with prominent Input/Output panels.
 */

import { Check, Copy, Info, X } from "lucide-react";
import { useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import type { DaprExecutionEvent } from "@/lib/types/workflow-ui";
import { SyntaxHighlightedJson } from "./json-panel";

// ============================================================================
// Types
// ============================================================================

type EventDetailsPanelProps = {
  event: DaprExecutionEvent;
  onClose: () => void;
};

// ============================================================================
// Helper Components
// ============================================================================

type JsonPanelProps = {
  title: string;
  data: unknown;
};

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
    <div className="overflow-hidden rounded-lg border border-border/50 bg-[#1e2433]">
      {/* Header */}
      <div className="flex items-center justify-between border-gray-700 border-b px-3 py-2">
        <span className="font-medium text-gray-300 text-sm">{title}</span>
        {hasData && (
          <Button
            className="h-6 px-2 text-teal-400 text-xs hover:bg-transparent hover:text-teal-300"
            onClick={handleCopy}
            size="sm"
            variant="ghost"
          >
            {copied ? (
              <>
                <Check className="mr-1 h-3 w-3" />
                Copied
              </>
            ) : (
              <>
                <Copy className="mr-1 h-3 w-3" />
                Copy
              </>
            )}
          </Button>
        )}
      </div>
      {/* Content with syntax highlighting */}
      <div className="max-h-48 overflow-auto p-3">
        {hasData ? (
          <SyntaxHighlightedJson data={data} />
        ) : (
          <p className="text-muted-foreground text-xs italic">No data</p>
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
  const executionTime =
    event.metadata?.executionDuration || event.metadata?.elapsed;

  return (
    <div className="flex h-full min-w-[320px] flex-col border-l bg-card">
      {/* Header - Activity name with close button */}
      <div className="flex items-start justify-between border-b px-4 py-3">
        <div className="min-w-0 flex-1">
          <h3 className="truncate font-semibold text-foreground text-lg">
            {event.name || event.eventType}
          </h3>
          {/* Type Badge */}
          <div className="mt-1">
            <Badge
              className="border-teal-500/30 bg-teal-500/10 text-teal-400 text-xs"
              variant="outline"
            >
              {event.eventType === "TaskCompleted" ||
              event.eventType === "TaskScheduled"
                ? "activity"
                : event.eventType
                    .toLowerCase()
                    .replace("orchestrator", "")
                    .replace("execution", "")}
            </Badge>
          </div>
        </div>
        <Button
          className="h-8 w-8 shrink-0"
          onClick={onClose}
          size="icon"
          variant="ghost"
        >
          <X className="h-4 w-4" />
          <span className="sr-only">Close</span>
        </Button>
      </div>

      {/* Content */}
      <div className="flex-1 space-y-4 overflow-auto p-4">
        {/* Execution Time - Prominent like Diagrid */}
        {executionTime && (
          <div className="flex items-center gap-2 text-sm">
            <span className="text-muted-foreground">Execution time:</span>
            <span className="font-semibold text-foreground">
              {executionTime}
            </span>
            <Info className="h-3.5 w-3.5 text-muted-foreground" />
          </div>
        )}

        {/* Input Panel - Always visible */}
        <JsonPanel data={event.input} title="Input" />

        {/* Output Panel - Always visible */}
        <JsonPanel data={event.output} title="Output" />
      </div>
    </div>
  );
}
