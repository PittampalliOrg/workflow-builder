"use client";

import { BarChart3, FileJson2, FileText, ListTodo } from "lucide-react";
import { useMemo } from "react";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  isDaprAgentOutput,
  parseDaprAgentOutput,
} from "@/lib/transforms/workflow-ui";
import { JsonPanel } from "./json-panel";
import { TaskListPanel } from "./task-list-panel";
import { TraceMetadataPanel } from "./trace-metadata-panel";
import { UsageMetricsPanel } from "./usage-metrics-panel";

// ============================================================================
// Types
// ============================================================================

type InputOutputSectionProps = {
  input: unknown;
  output: unknown;
  /** Raw DaprAgentOutput preserved from API */
  daprAgentOutput?: unknown;
};

// ============================================================================
// Summary Tab Content
// ============================================================================

type SummaryTabProps = {
  planText: string | undefined;
  taskCount: number;
  totalTokens: number | undefined;
  traceId: string | undefined;
};

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
          <h4 className="mb-2 font-medium text-gray-300 text-sm">
            Plan Output
          </h4>
          <p className="whitespace-pre-wrap text-gray-200 text-sm">
            {planText}
          </p>
        </div>
      )}

      {/* Quick Stats */}
      <div className="flex items-center gap-4 text-sm">
        {taskCount > 0 && (
          <span className="text-gray-400">
            <span className="font-medium text-teal-400">{taskCount}</span> tasks
            created
          </span>
        )}
        {totalTokens !== undefined && (
          <span className="text-gray-400">
            <span className="font-medium text-amber-400">
              {totalTokens.toLocaleString()}
            </span>{" "}
            tokens used
          </span>
        )}
        {traceId && (
          <span className="text-gray-400">
            Trace:{" "}
            <code className="rounded bg-gray-800 px-1 py-0.5 text-gray-300 text-xs">
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

type DaprAgentOutputSectionProps = {
  output: unknown;
};

function DaprAgentOutputSection({ output }: DaprAgentOutputSectionProps) {
  const parsed = useMemo(() => parseDaprAgentOutput(output), [output]);
  const tasks = parsed?.tasks ?? [];
  const usage = parsed?.usage;
  const traceId = parsed?.trace_id;
  const trace = parsed?.trace_metadata;
  const planText = parsed?.plan_text;

  const hasTasks = tasks.length > 0;
  const hasUsage = usage !== undefined;

  return (
    <div className="overflow-hidden rounded-lg border bg-[#1e2433]">
      {/* Header */}
      <div className="border-gray-700 border-b px-4 py-2">
        <span className="font-medium text-gray-300 text-sm">Output</span>
      </div>

      {/* Tabbed Content */}
      <Tabs className="w-full" defaultValue="summary">
        <div className="border-gray-700 border-b px-4 pt-2">
          <TabsList className="h-auto gap-0 border-0 bg-transparent p-0">
            <TabsTrigger
              className="gap-2 rounded-none border-transparent border-b-2 px-4 py-2 text-gray-400 data-[state=active]:border-teal-400 data-[state=active]:bg-transparent data-[state=active]:text-gray-200"
              value="summary"
            >
              <FileText className="h-4 w-4" />
              Summary
            </TabsTrigger>
            {hasTasks && (
              <TabsTrigger
                className="gap-2 rounded-none border-transparent border-b-2 px-4 py-2 text-gray-400 data-[state=active]:border-teal-400 data-[state=active]:bg-transparent data-[state=active]:text-gray-200"
                value="tasks"
              >
                <ListTodo className="h-4 w-4" />
                Tasks ({tasks.length})
              </TabsTrigger>
            )}
            {hasUsage && (
              <TabsTrigger
                className="gap-2 rounded-none border-transparent border-b-2 px-4 py-2 text-gray-400 data-[state=active]:border-teal-400 data-[state=active]:bg-transparent data-[state=active]:text-gray-200"
                value="usage"
              >
                <BarChart3 className="h-4 w-4" />
                Usage
              </TabsTrigger>
            )}
            <TabsTrigger
              className="gap-2 rounded-none border-transparent border-b-2 px-4 py-2 text-gray-400 data-[state=active]:border-teal-400 data-[state=active]:bg-transparent data-[state=active]:text-gray-200"
              value="raw"
            >
              <FileJson2 className="h-4 w-4" />
              Raw JSON
            </TabsTrigger>
          </TabsList>
        </div>

        <div className="p-4">
          <TabsContent className="mt-0" value="summary">
            <SummaryTab
              planText={planText}
              taskCount={tasks.length}
              totalTokens={usage?.total_tokens}
              traceId={traceId}
            />
          </TabsContent>

          {hasTasks && (
            <TabsContent className="mt-0" value="tasks">
              <TaskListPanel tasks={tasks} />
            </TabsContent>
          )}

          {hasUsage && (
            <TabsContent className="mt-0 space-y-4" value="usage">
              <UsageMetricsPanel usage={usage} />
              {trace && <TraceMetadataPanel trace={trace} />}
            </TabsContent>
          )}

          <TabsContent className="mt-0" value="raw">
            <JsonPanel
              data={output}
              maxHeight="300px"
              showExpand
              title="Raw Output"
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
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        <JsonPanel data={input} maxHeight="250px" title="Input" />
        <DaprAgentOutputSection output={effectiveOutput} />
      </div>
    );
  }

  // Default: Regular JSON panels for non-DaprAgent output
  return (
    <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
      <JsonPanel data={input} maxHeight="250px" title="Input" />
      <JsonPanel data={output} maxHeight="250px" title="Output" />
    </div>
  );
}
