"use client";

import { ArrowDownRight, ArrowUpRight, Coins } from "lucide-react";
import { formatTokenCount } from "@/lib/transforms/workflow-ui";
import type { TokenUsage } from "@/lib/types/workflow-ui";
import { cn } from "@/lib/utils";

// ============================================================================
// Types
// ============================================================================

type UsageMetricsPanelProps = {
  usage: TokenUsage;
  className?: string;
  compact?: boolean;
};

type MetricCardProps = {
  label: string;
  value: number;
  icon: React.ReactNode;
  colorClass: string;
  compact?: boolean;
};

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
        <span className="text-gray-400 text-xs">{label}:</span>
        <span className={cn("font-medium text-sm", colorClass)}>
          {formatTokenCount(value)}
        </span>
      </div>
    );
  }

  return (
    <div className="rounded-lg border border-gray-700 bg-[#1e2433] p-4">
      <div className="mb-2 flex items-center gap-2">
        <span className={colorClass}>{icon}</span>
        <span className="text-gray-400 text-sm">{label}</span>
      </div>
      <p className={cn("font-semibold text-2xl", colorClass)}>
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
          colorClass="text-blue-400"
          compact
          icon={<ArrowDownRight className="h-3 w-3" />}
          label="Input"
          value={usage.input_tokens}
        />
        <MetricCard
          colorClass="text-green-400"
          compact
          icon={<ArrowUpRight className="h-3 w-3" />}
          label="Output"
          value={usage.output_tokens}
        />
        <MetricCard
          colorClass="text-amber-400"
          compact
          icon={<Coins className="h-3 w-3" />}
          label="Total"
          value={usage.total_tokens}
        />
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
      <div className="border-gray-700 border-b px-4 py-2">
        <span className="font-medium text-gray-300 text-sm">Token Usage</span>
      </div>

      {/* Metrics Grid */}
      <div className="grid grid-cols-3 gap-4 p-4">
        <MetricCard
          colorClass="text-blue-400"
          icon={<ArrowDownRight className="h-4 w-4" />}
          label="Input Tokens"
          value={usage.input_tokens}
        />
        <MetricCard
          colorClass="text-green-400"
          icon={<ArrowUpRight className="h-4 w-4" />}
          label="Output Tokens"
          value={usage.output_tokens}
        />
        <MetricCard
          colorClass="text-amber-400"
          icon={<Coins className="h-4 w-4" />}
          label="Total Tokens"
          value={usage.total_tokens}
        />
      </div>
    </div>
  );
}
