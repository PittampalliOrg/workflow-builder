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

import { useState, useMemo } from "react";
import { GitBranch, History, Network, ListTodo } from "lucide-react";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  ResizablePanelGroup,
  ResizablePanel,
  ResizableHandle,
} from "@/components/ui/resizable";
import { ExecutionHistoryTable } from "./execution-history-table";
import { ExecutionFlow } from "./execution-flow";
import { EventDetailsPanel } from "./event-details-panel";
import { TaskDagGraph } from "./task-dag-graph";
import { TaskListPanel } from "./task-list-panel";
import type { DaprExecutionEvent, DaprAgentTask } from "@/lib/types/workflow-ui";
import {
  isDaprAgentOutput,
  parseDaprAgentOutput,
} from "@/lib/transforms/workflow-ui";

// ============================================================================
// Types
// ============================================================================

interface WorkflowDetailTabsProps {
  events: DaprExecutionEvent[];
  /** Optional workflow output - if DaprAgentOutput, shows Tasks tab */
  output?: unknown;
  /** Raw DaprAgentOutput preserved from API */
  daprAgentOutput?: unknown;
  defaultTab?: "graph" | "history" | "tasks" | "relationships";
}

// ============================================================================
// Placeholder Components
// ============================================================================

function RelationshipsPlaceholder() {
  return (
    <div className="flex flex-col items-center justify-center py-16 text-center">
      <div className="rounded-full bg-muted p-4 mb-4">
        <Network className="h-8 w-8 text-muted-foreground" />
      </div>
      <h3 className="text-lg font-medium">Relationships</h3>
      <p className="text-sm text-muted-foreground mt-1 max-w-md">
        View workflow dependencies and related executions in a future update.
      </p>
    </div>
  );
}

// ============================================================================
// Tasks Tab Content
// ============================================================================

interface TasksTabContentProps {
  tasks: DaprAgentTask[];
}

function TasksTabContent({ tasks }: TasksTabContentProps) {
  const [selectedTask, setSelectedTask] = useState<DaprAgentTask | null>(null);

  if (tasks.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-16 text-center">
        <div className="rounded-full bg-muted p-4 mb-4">
          <ListTodo className="h-8 w-8 text-muted-foreground" />
        </div>
        <h3 className="text-lg font-medium">No Tasks</h3>
        <p className="text-sm text-muted-foreground mt-1 max-w-md">
          This workflow does not have any tasks to display.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Task DAG Graph */}
      <div className="rounded-lg border border-gray-700 bg-[#1a1f2e] overflow-hidden">
        <div className="px-4 py-2 border-b border-gray-700">
          <span className="text-sm font-medium text-gray-300">
            Task Dependency Graph
          </span>
        </div>
        <TaskDagGraph
          tasks={tasks}
          onTaskSelect={setSelectedTask}
          selectedTaskId={selectedTask?.id}
          className="h-[350px]"
        />
      </div>

      {/* Task List */}
      <TaskListPanel tasks={tasks} defaultExpanded={false} />
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
  const tabCount = hasTasks ? 4 : 3;
  const gridColsClass = hasTasks ? "grid-cols-4" : "grid-cols-3";

  return (
    <Tabs defaultValue={defaultTab} className="w-full">
      <TabsList className={`grid w-full ${gridColsClass} max-w-lg`}>
        <TabsTrigger value="graph" className="gap-2">
          <GitBranch className="h-4 w-4" />
          Graph
        </TabsTrigger>
        <TabsTrigger value="history" className="gap-2">
          <History className="h-4 w-4" />
          History
        </TabsTrigger>
        {hasTasks && (
          <TabsTrigger value="tasks" className="gap-2">
            <ListTodo className="h-4 w-4" />
            Tasks
          </TabsTrigger>
        )}
        <TabsTrigger value="relationships" className="gap-2">
          <Network className="h-4 w-4" />
          Relationships
        </TabsTrigger>
      </TabsList>

      <TabsContent value="graph" className="mt-6">
        <ResizablePanelGroup direction="horizontal" className="min-h-[500px]">
          <ResizablePanel defaultSize={selectedEvent ? 65 : 100} minSize={40}>
            <ExecutionFlow
              events={events}
              onEventSelect={setSelectedEvent}
              selectedEventId={selectedEvent?.eventId}
              className="h-full"
            />
          </ResizablePanel>
          {selectedEvent && (
            <>
              <ResizableHandle withHandle />
              <ResizablePanel defaultSize={35} minSize={25} maxSize={50}>
                <EventDetailsPanel
                  event={selectedEvent}
                  onClose={() => setSelectedEvent(null)}
                />
              </ResizablePanel>
            </>
          )}
        </ResizablePanelGroup>
      </TabsContent>

      <TabsContent value="history" className="mt-6">
        <div className="flex items-center justify-between mb-4">
          <span className="text-sm text-muted-foreground">
            {events.length} events
          </span>
        </div>
        <ExecutionHistoryTable events={events} />
      </TabsContent>

      {hasTasks && (
        <TabsContent value="tasks" className="mt-6">
          <TasksTabContent tasks={tasks} />
        </TabsContent>
      )}

      <TabsContent value="relationships" className="mt-6">
        <RelationshipsPlaceholder />
      </TabsContent>
    </Tabs>
  );
}
