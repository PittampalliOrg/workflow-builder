"use client";

import { ArrowDownRight, ArrowUpRight, Coins } from "lucide-react";
import { cn } from "@/lib/utils";
import type { TokenUsage } from "@/lib/types/workflow-ui";
import { formatTokenCount } from "@/lib/transforms/workflow-ui";

// ============================================================================
// Types
// ============================================================================

interface UsageMetricsPanelProps {
  usage: TokenUsage;
  className?: string;
  compact?: boolean;
}

interface MetricCardProps {
  label: string;
  value: number;
  icon: React.ReactNode;
  colorClass: string;
  compact?: boolean;
}

// ============================================================================
// Metric Card Component
// ============================================================================

function MetricCard({
  label,
  value,
  icon,
  colorClass,
  compact = false,
}: MetricCardProps) {
  if (compact) {
    return (
      <div className="flex items-center gap-2">
        <span className={cn("", colorClass)}>{icon}</span>
        <span className="text-xs text-gray-400">{label}:</span>
        <span className={cn("text-sm font-medium", colorClass)}>
          {formatTokenCount(value)}
        </span>
      </div>
    );
  }

  return (
    <div className="rounded-lg border border-gray-700 bg-[#1e2433] p-4">
      <div className="flex items-center gap-2 mb-2">
        <span className={colorClass}>{icon}</span>
        <span className="text-sm text-gray-400">{label}</span>
      </div>
      <p className={cn("text-2xl font-semibold", colorClass)}>
        {formatTokenCount(value)}
      </p>
    </div>
  );
}

// ============================================================================
// Main Component
// ============================================================================

export function UsageMetricsPanel({
  usage,
  className,
  compact = false,
}: UsageMetricsPanelProps) {
  if (compact) {
    return (
      <div className={cn("flex items-center gap-4", className)}>
        <MetricCard
          label="Input"
          value={usage.input_tokens}
          icon={<ArrowDownRight className="h-3 w-3" />}
          colorClass="text-blue-400"
          compact
        />
        <MetricCard
          label="Output"
          value={usage.output_tokens}
          icon={<ArrowUpRight className="h-3 w-3" />}
          colorClass="text-green-400"
          compact
        />
        <MetricCard
          label="Total"
          value={usage.total_tokens}
          icon={<Coins className="h-3 w-3" />}
          colorClass="text-amber-400"
          compact
        />
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
      <div className="px-4 py-2 border-b border-gray-700">
        <span className="text-sm font-medium text-gray-300">Token Usage</span>
      </div>

      {/* Metrics Grid */}
      <div className="p-4 grid grid-cols-3 gap-4">
        <MetricCard
          label="Input Tokens"
          value={usage.input_tokens}
          icon={<ArrowDownRight className="h-4 w-4" />}
          colorClass="text-blue-400"
        />
        <MetricCard
          label="Output Tokens"
          value={usage.output_tokens}
          icon={<ArrowUpRight className="h-4 w-4" />}
          colorClass="text-green-400"
        />
        <MetricCard
          label="Total Tokens"
          value={usage.total_tokens}
          icon={<Coins className="h-4 w-4" />}
          colorClass="text-amber-400"
        />
      </div>
    </div>
  );
}
