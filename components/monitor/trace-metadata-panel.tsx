"use client";

import { Activity, Check, Copy, ExternalLink } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import type { TraceMetadata } from "@/lib/types/workflow-ui";
import { cn } from "@/lib/utils";

// ============================================================================
// Types
// ============================================================================

type TraceMetadataPanelProps = {
  trace: TraceMetadata;
  className?: string;
  compact?: boolean;
};

type TraceFieldProps = {
  label: string;
  value: string | undefined;
  truncate?: boolean;
  copyable?: boolean;
  linkUrl?: string;
};

// ============================================================================
// Trace Field Component
// ============================================================================

function TraceField({
  label,
  value,
  truncate = true,
  copyable = true,
  linkUrl,
}: TraceFieldProps) {
  const [copied, setCopied] = useState(false);

  if (!value) {
    return null;
  }

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (err) {
      console.error("Failed to copy:", err);
    }
  };

  const displayValue =
    truncate && value.length > 24
      ? `${value.slice(0, 12)}...${value.slice(-8)}`
      : value;

  return (
    <div className="flex items-center gap-2">
      <span className="text-gray-400 text-xs">{label}:</span>
      <code
        className={cn(
          "rounded bg-gray-800 px-1.5 py-0.5 font-mono text-gray-200 text-xs",
          truncate && "max-w-[200px] truncate"
        )}
        title={value}
      >
        {displayValue}
      </code>
      {copyable && (
        <Button
          className="h-auto p-1 text-gray-400 hover:text-gray-200"
          onClick={handleCopy}
          size="sm"
          variant="ghost"
        >
          {copied ? (
            <Check className="h-3 w-3 text-green-400" />
          ) : (
            <Copy className="h-3 w-3" />
          )}
        </Button>
      )}
      {linkUrl && (
        <a
          className="text-teal-400 hover:text-teal-300"
          href={linkUrl}
          rel="noopener noreferrer"
          target="_blank"
        >
          <ExternalLink className="h-3 w-3" />
        </a>
      )}
    </div>
  );
}

// ============================================================================
// Main Component
// ============================================================================

export function TraceMetadataPanel({
  trace,
  className,
  compact = false,
}: TraceMetadataPanelProps) {
  const hasData = trace.trace_id || trace.agent_span_id || trace.workflow_name;

  if (!hasData) {
    return null;
  }

  if (compact) {
    return (
      <div className={cn("flex flex-wrap items-center gap-4", className)}>
        {trace.trace_id && <TraceField label="Trace" value={trace.trace_id} />}
        {trace.agent_span_id && (
          <TraceField label="Span" value={trace.agent_span_id} />
        )}
      </div>
    );
  }

  return (
    <div
      className={cn(
        "overflow-hidden rounded-lg border border-gray-700 bg-[#1a1f2e]",
        className
      )}
    >
      {/* Header */}
      <div className="flex items-center gap-2 border-gray-700 border-b px-4 py-2">
        <Activity className="h-4 w-4 text-teal-400" />
        <span className="font-medium text-gray-300 text-sm">
          Trace Information
        </span>
      </div>

      {/* Content */}
      <div className="space-y-3 p-4">
        {trace.workflow_name && (
          <TraceField
            copyable={false}
            label="Workflow"
            truncate={false}
            value={trace.workflow_name}
          />
        )}
        {trace.trace_id && (
          <TraceField label="Trace ID" value={trace.trace_id} />
        )}
        {trace.agent_span_id && (
          <TraceField label="Agent Span ID" value={trace.agent_span_id} />
        )}

        {/* Additional metadata */}
        {trace.metadata && Object.keys(trace.metadata).length > 0 && (
          <div className="border-gray-700 border-t pt-2">
            <span className="mb-2 block text-gray-400 text-xs">Metadata</span>
            <div className="space-y-1">
              {Object.entries(trace.metadata).map(([key, value]) => (
                <div className="flex items-center gap-2 text-xs" key={key}>
                  <span className="text-gray-500">{key}:</span>
                  <span className="text-gray-300">
                    {typeof value === "object"
                      ? JSON.stringify(value)
                      : String(value)}
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
