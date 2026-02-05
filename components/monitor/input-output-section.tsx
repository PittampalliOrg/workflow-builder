"use client";

import { useMemo } from "react";
import { ListTodo, BarChart3, FileJson2, FileText } from "lucide-react";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { JsonPanel } from "./json-panel";
import { TaskListPanel } from "./task-list-panel";
import { UsageMetricsPanel } from "./usage-metrics-panel";
import { TraceMetadataPanel } from "./trace-metadata-panel";
import {
  isDaprAgentOutput,
  parseDaprAgentOutput,
} from "@/lib/transforms/workflow-ui";
import { cn } from "@/lib/utils";

// ============================================================================
// Types
// ============================================================================

interface InputOutputSectionProps {
  input: unknown;
  output: unknown;
  /** Raw DaprAgentOutput preserved from API */
  daprAgentOutput?: unknown;
}

// ============================================================================
// Summary Tab Content
// ============================================================================

interface SummaryTabProps {
  planText: string | undefined;
  taskCount: number;
  totalTokens: number | undefined;
  traceId: string | undefined;
}

function SummaryTab({
  planText,
  taskCount,
  totalTokens,
  traceId,
}: SummaryTabProps) {
  return (
    <div className="space-y-4">
      {/* Plan Output */}
      {planText && (
        <div className="rounded-lg border border-gray-700 bg-[#1e2433] p-4">
          <h4 className="text-sm font-medium text-gray-300 mb-2">Plan Output</h4>
          <p className="text-sm text-gray-200 whitespace-pre-wrap">{planText}</p>
        </div>
      )}

      {/* Quick Stats */}
      <div className="flex items-center gap-4 text-sm">
        {taskCount > 0 && (
          <span className="text-gray-400">
            <span className="text-teal-400 font-medium">{taskCount}</span> tasks
            created
          </span>
        )}
        {totalTokens !== undefined && (
          <span className="text-gray-400">
            <span className="text-amber-400 font-medium">
              {totalTokens.toLocaleString()}
            </span>{" "}
            tokens used
          </span>
        )}
        {traceId && (
          <span className="text-gray-400">
            Trace:{" "}
            <code className="text-xs bg-gray-800 px-1 py-0.5 rounded text-gray-300">
              {traceId.slice(0, 12)}...
            </code>
          </span>
        )}
      </div>
    </div>
  );
}

// ============================================================================
// DaprAgent Output Section (Tabbed)
// ============================================================================

interface DaprAgentOutputSectionProps {
  output: unknown;
}

function DaprAgentOutputSection({ output }: DaprAgentOutputSectionProps) {
  const { tasks, usage, trace, planText } = useMemo(
    () => parseDaprAgentOutput(output),
    [output]
  );

  const hasTasks = tasks.length > 0;
  const hasUsage = usage !== undefined;

  return (
    <div className="rounded-lg border bg-[#1e2433] overflow-hidden">
      {/* Header */}
      <div className="px-4 py-2 border-b border-gray-700">
        <span className="text-sm font-medium text-gray-300">Output</span>
      </div>

      {/* Tabbed Content */}
      <Tabs defaultValue="summary" className="w-full">
        <div className="px-4 pt-2 border-b border-gray-700">
          <TabsList className="bg-transparent border-0 p-0 h-auto gap-0">
            <TabsTrigger
              value="summary"
              className="gap-2 px-4 py-2 rounded-none border-b-2 border-transparent data-[state=active]:border-teal-400 data-[state=active]:bg-transparent data-[state=active]:text-gray-200 text-gray-400"
            >
              <FileText className="h-4 w-4" />
              Summary
            </TabsTrigger>
            {hasTasks && (
              <TabsTrigger
                value="tasks"
                className="gap-2 px-4 py-2 rounded-none border-b-2 border-transparent data-[state=active]:border-teal-400 data-[state=active]:bg-transparent data-[state=active]:text-gray-200 text-gray-400"
              >
                <ListTodo className="h-4 w-4" />
                Tasks ({tasks.length})
              </TabsTrigger>
            )}
            {hasUsage && (
              <TabsTrigger
                value="usage"
                className="gap-2 px-4 py-2 rounded-none border-b-2 border-transparent data-[state=active]:border-teal-400 data-[state=active]:bg-transparent data-[state=active]:text-gray-200 text-gray-400"
              >
                <BarChart3 className="h-4 w-4" />
                Usage
              </TabsTrigger>
            )}
            <TabsTrigger
              value="raw"
              className="gap-2 px-4 py-2 rounded-none border-b-2 border-transparent data-[state=active]:border-teal-400 data-[state=active]:bg-transparent data-[state=active]:text-gray-200 text-gray-400"
            >
              <FileJson2 className="h-4 w-4" />
              Raw JSON
            </TabsTrigger>
          </TabsList>
        </div>

        <div className="p-4">
          <TabsContent value="summary" className="mt-0">
            <SummaryTab
              planText={planText}
              taskCount={tasks.length}
              totalTokens={usage?.total_tokens}
              traceId={trace?.trace_id}
            />
          </TabsContent>

          {hasTasks && (
            <TabsContent value="tasks" className="mt-0">
              <TaskListPanel tasks={tasks} />
            </TabsContent>
          )}

          {hasUsage && (
            <TabsContent value="usage" className="mt-0 space-y-4">
              <UsageMetricsPanel usage={usage} />
              {trace && <TraceMetadataPanel trace={trace} />}
            </TabsContent>
          )}

          <TabsContent value="raw" className="mt-0">
            <JsonPanel
              title="Raw Output"
              data={output}
              maxHeight="300px"
              showExpand
            />
          </TabsContent>
        </div>
      </Tabs>
    </div>
  );
}

// ============================================================================
// Main Component
// ============================================================================

export function InputOutputSection({
  input,
  output,
  daprAgentOutput,
}: InputOutputSectionProps) {
  // Use daprAgentOutput if available, otherwise fall back to checking output
  const effectiveOutput = daprAgentOutput ?? output;
  const isDaprAgent = useMemo(
    () => isDaprAgentOutput(effectiveOutput),
    [effectiveOutput]
  );

  if (isDaprAgent) {
    return (
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <JsonPanel title="Input" data={input} maxHeight="250px" />
        <DaprAgentOutputSection output={effectiveOutput} />
      </div>
    );
  }

  // Default: Regular JSON panels for non-DaprAgent output
  return (
    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
      <JsonPanel title="Input" data={input} maxHeight="250px" />
      <JsonPanel title="Output" data={output} maxHeight="250px" />
    </div>
  );
}
