"use client";

/**
 * WorkflowDetailTabs Component
 *
 * Tabs for the workflow detail page:
 * - Graph tab: React Flow visualization of execution events
 * - History tab: Execution history table
 * - Tasks tab: Task dependency graph and list (for DaprAgent workflows)
 * - Relationships tab: (placeholder for future implementation)
 */

import { GitBranch, History, ListTodo, Network } from "lucide-react";
import { useMemo, useState } from "react";
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "@/components/ui/resizable";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  isDaprAgentOutput,
  parseDaprAgentOutput,
} from "@/lib/transforms/workflow-ui";
import type {
  DaprAgentTask,
  DaprExecutionEvent,
} from "@/lib/types/workflow-ui";
import { EventDetailsPanel } from "./event-details-panel";
import { ExecutionFlow } from "./execution-flow";
import { ExecutionHistoryTable } from "./execution-history-table";
import { TaskDagGraph } from "./task-dag-graph";
import { TaskListPanel } from "./task-list-panel";

// ============================================================================
// Types
// ============================================================================

type WorkflowDetailTabsProps = {
  events: DaprExecutionEvent[];
  /** Optional workflow output - if DaprAgentOutput, shows Tasks tab */
  output?: unknown;
  /** Raw DaprAgentOutput preserved from API */
  daprAgentOutput?: unknown;
  defaultTab?: "graph" | "history" | "tasks" | "relationships";
};

// ============================================================================
// Placeholder Components
// ============================================================================

function RelationshipsPlaceholder() {
  return (
    <div className="flex flex-col items-center justify-center py-16 text-center">
      <div className="mb-4 rounded-full bg-muted p-4">
        <Network className="h-8 w-8 text-muted-foreground" />
      </div>
      <h3 className="font-medium text-lg">Relationships</h3>
      <p className="mt-1 max-w-md text-muted-foreground text-sm">
        View workflow dependencies and related executions in a future update.
      </p>
    </div>
  );
}

// ============================================================================
// Tasks Tab Content
// ============================================================================

type TasksTabContentProps = {
  tasks: DaprAgentTask[];
};

function TasksTabContent({ tasks }: TasksTabContentProps) {
  const [, setSelectedTask] = useState<DaprAgentTask | null>(null);

  if (tasks.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-16 text-center">
        <div className="mb-4 rounded-full bg-muted p-4">
          <ListTodo className="h-8 w-8 text-muted-foreground" />
        </div>
        <h3 className="font-medium text-lg">No Tasks</h3>
        <p className="mt-1 max-w-md text-muted-foreground text-sm">
          This workflow does not have any tasks to display.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Task DAG Graph */}
      <div className="overflow-hidden rounded-lg border border-gray-700 bg-[#1a1f2e]">
        <div className="border-gray-700 border-b px-4 py-2">
          <span className="font-medium text-gray-300 text-sm">
            Task Dependency Graph
          </span>
        </div>
        <TaskDagGraph
          className="h-[350px]"
          onTaskSelect={setSelectedTask}
          tasks={tasks}
        />
      </div>

      {/* Task List */}
      <TaskListPanel defaultExpanded={false} tasks={tasks} />
    </div>
  );
}

// ============================================================================
// Main Component
// ============================================================================

export function WorkflowDetailTabs({
  events,
  output,
  daprAgentOutput,
  defaultTab = "graph",
}: WorkflowDetailTabsProps) {
  const [selectedEvent, setSelectedEvent] = useState<DaprExecutionEvent | null>(
    null
  );

  // Parse tasks from daprAgentOutput (preferred) or output fallback
  const tasks = useMemo(() => {
    const effectiveOutput = daprAgentOutput ?? output;
    if (isDaprAgentOutput(effectiveOutput)) {
      return parseDaprAgentOutput(effectiveOutput)?.tasks ?? [];
    }
    return [];
  }, [daprAgentOutput, output]);

  const hasTasks = tasks.length > 0;

  // Determine grid columns based on whether tasks tab exists
  const _tabCount = hasTasks ? 4 : 3;
  const gridColsClass = hasTasks ? "grid-cols-4" : "grid-cols-3";

  return (
    <Tabs className="w-full" defaultValue={defaultTab}>
      <TabsList className={`grid w-full ${gridColsClass} max-w-lg`}>
        <TabsTrigger className="gap-2" value="graph">
          <GitBranch className="h-4 w-4" />
          Graph
        </TabsTrigger>
        <TabsTrigger className="gap-2" value="history">
          <History className="h-4 w-4" />
          History
        </TabsTrigger>
        {hasTasks && (
          <TabsTrigger className="gap-2" value="tasks">
            <ListTodo className="h-4 w-4" />
            Tasks
          </TabsTrigger>
        )}
        <TabsTrigger className="gap-2" value="relationships">
          <Network className="h-4 w-4" />
          Relationships
        </TabsTrigger>
      </TabsList>

      <TabsContent className="mt-6" value="graph">
        <ResizablePanelGroup className="min-h-[500px]" direction="horizontal">
          <ResizablePanel defaultSize={selectedEvent ? 65 : 100} minSize={40}>
            <ExecutionFlow
              className="h-full"
              events={events}
              onEventSelect={setSelectedEvent}
            />
          </ResizablePanel>
          {selectedEvent && (
            <>
              <ResizableHandle withHandle />
              <ResizablePanel defaultSize={35} maxSize={50} minSize={25}>
                <EventDetailsPanel
                  event={selectedEvent}
                  onClose={() => setSelectedEvent(null)}
                />
              </ResizablePanel>
            </>
          )}
        </ResizablePanelGroup>
      </TabsContent>

      <TabsContent className="mt-6" value="history">
        <div className="mb-4 flex items-center justify-between">
          <span className="text-muted-foreground text-sm">
            {events.length} events
          </span>
        </div>
        <ExecutionHistoryTable events={events} />
      </TabsContent>

      {hasTasks && (
        <TabsContent className="mt-6" value="tasks">
          <TasksTabContent tasks={tasks} />
        </TabsContent>
      )}

      <TabsContent className="mt-6" value="relationships">
        <RelationshipsPlaceholder />
      </TabsContent>
    </Tabs>
  );
}
