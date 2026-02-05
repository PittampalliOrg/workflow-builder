"use client";

import { useState } from "react";
import { Check, Copy, ExternalLink, Activity } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import type { TraceMetadata } from "@/lib/types/workflow-ui";

// ============================================================================
// Types
// ============================================================================

interface TraceMetadataPanelProps {
  trace: TraceMetadata;
  className?: string;
  compact?: boolean;
}

interface TraceFieldProps {
  label: string;
  value: string | undefined;
  truncate?: boolean;
  copyable?: boolean;
  linkUrl?: string;
}

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

  if (!value) return null;

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (err) {
      console.error("Failed to copy:", err);
    }
  };

  const displayValue = truncate && value.length > 24
    ? `${value.slice(0, 12)}...${value.slice(-8)}`
    : value;

  return (
    <div className="flex items-center gap-2">
      <span className="text-xs text-gray-400">{label}:</span>
      <code
        className={cn(
          "px-1.5 py-0.5 bg-gray-800 rounded text-xs font-mono text-gray-200",
          truncate && "truncate max-w-[200px]"
        )}
        title={value}
      >
        {displayValue}
      </code>
      {copyable && (
        <Button
          variant="ghost"
          size="sm"
          className="h-auto p-1 text-gray-400 hover:text-gray-200"
          onClick={handleCopy}
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
          href={linkUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="text-teal-400 hover:text-teal-300"
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
      <div className={cn("flex items-center gap-4 flex-wrap", className)}>
        {trace.trace_id && (
          <TraceField label="Trace" value={trace.trace_id} />
        )}
        {trace.agent_span_id && (
          <TraceField label="Span" value={trace.agent_span_id} />
        )}
      </div>
    );
  }

  return (
    <div
      className={cn(
        "rounded-lg border border-gray-700 bg-[#1a1f2e] overflow-hidden",
        className
      )}
    >
      {/* Header */}
      <div className="flex items-center gap-2 px-4 py-2 border-b border-gray-700">
        <Activity className="h-4 w-4 text-teal-400" />
        <span className="text-sm font-medium text-gray-300">
          Trace Information
        </span>
      </div>

      {/* Content */}
      <div className="p-4 space-y-3">
        {trace.workflow_name && (
          <TraceField
            label="Workflow"
            value={trace.workflow_name}
            truncate={false}
            copyable={false}
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
          <div className="pt-2 border-t border-gray-700">
            <span className="text-xs text-gray-400 block mb-2">Metadata</span>
            <div className="space-y-1">
              {Object.entries(trace.metadata).map(([key, value]) => (
                <div key={key} className="flex items-center gap-2 text-xs">
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
