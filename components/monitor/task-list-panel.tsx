"use client";

import {
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Circle,
  Loader2,
  XCircle,
} from "lucide-react";
import { useState } from "react";
import type {
  DaprAgentTask,
  DaprAgentTaskStatus,
} from "@/lib/types/workflow-ui";
import {
  getTaskStatusBgColor,
  getTaskStatusColor,
} from "@/lib/types/workflow-ui";
import { cn } from "@/lib/utils";

// ============================================================================
// Types
// ============================================================================

type TaskListPanelProps = {
  tasks: DaprAgentTask[];
  className?: string;
  defaultExpanded?: boolean;
};

type TaskItemProps = {
  task: DaprAgentTask;
  allTasks: DaprAgentTask[];
  defaultExpanded?: boolean;
};

// ============================================================================
// Status Icon Component
// ============================================================================

function TaskStatusIcon({ status }: { status: DaprAgentTaskStatus }) {
  const colorClass = getTaskStatusColor(status);

  switch (status) {
    case "pending":
      return <Circle className={cn("h-4 w-4", colorClass)} />;
    case "in_progress":
      return <Loader2 className={cn("h-4 w-4 animate-spin", colorClass)} />;
    case "completed":
      return <CheckCircle2 className={cn("h-4 w-4", colorClass)} />;
    case "failed":
      return <XCircle className={cn("h-4 w-4", colorClass)} />;
    default:
      return <Circle className={cn("h-4 w-4", colorClass)} />;
  }
}

// ============================================================================
// Task Item Component
// ============================================================================

function TaskItem({ task, allTasks, defaultExpanded = false }: TaskItemProps) {
  const [expanded, setExpanded] = useState(defaultExpanded);

  // Get task subjects for dependencies
  const getTaskSubject = (id: string): string => {
    const t = allTasks.find((t) => t.id === id);
    return t ? `#${t.id} ${t.subject}` : `#${id}`;
  };

  const hasDetails =
    task.description || task.blockedBy.length > 0 || task.blocks.length > 0;

  const headerClassName = cn(
    "flex w-full items-center gap-3 px-4 py-3 text-left transition-colors",
    hasDetails && "cursor-pointer hover:bg-gray-800/50"
  );

  const headerContent = (
    <>
      {/* Expand Icon */}
      {hasDetails ? (
        expanded ? (
          <ChevronDown className="h-4 w-4 shrink-0 text-gray-400" />
        ) : (
          <ChevronRight className="h-4 w-4 shrink-0 text-gray-400" />
        )
      ) : (
        <div className="w-4 shrink-0" />
      )}

      {/* Status Icon */}
      <TaskStatusIcon status={task.status} />

      {/* Task ID & Subject */}
      <div className="min-w-0 flex-1">
        <span className="font-medium text-gray-300 text-sm">#{task.id}</span>
        <span className="mx-2 text-gray-500">·</span>
        <span className="truncate text-gray-200 text-sm">{task.subject}</span>
      </div>

      {/* Status Badge */}
      <span
        className={cn(
          "shrink-0 rounded-full px-2 py-0.5 text-xs",
          getTaskStatusBgColor(task.status),
          getTaskStatusColor(task.status)
        )}
      >
        {task.status.replace("_", " ")}
      </span>
    </>
  );

  return (
    <div className="border-gray-700 border-b last:border-b-0">
      {/* Task Header */}
      {hasDetails ? (
        <button
          aria-expanded={expanded}
          className={headerClassName}
          onClick={() => setExpanded((v) => !v)}
          type="button"
        >
          {headerContent}
        </button>
      ) : (
        <div className={headerClassName}>{headerContent}</div>
      )}

      {/* Expanded Details */}
      {expanded && hasDetails && (
        <div className="space-y-2 px-4 pb-3 pl-11">
          {/* Description */}
          {task.description && (
            <p className="whitespace-pre-wrap text-gray-400 text-sm">
              {task.description}
            </p>
          )}

          {/* Dependencies */}
          {task.blockedBy.length > 0 && (
            <div className="flex items-start gap-2 text-xs">
              <span className="shrink-0 text-gray-500">blockedBy:</span>
              <div className="flex flex-wrap gap-1">
                {task.blockedBy.map((id) => (
                  <span
                    className="rounded bg-red-500/10 px-1.5 py-0.5 text-red-400"
                    key={id}
                  >
                    {getTaskSubject(id)}
                  </span>
                ))}
              </div>
            </div>
          )}

          {task.blocks.length > 0 && (
            <div className="flex items-start gap-2 text-xs">
              <span className="shrink-0 text-gray-500">blocks:</span>
              <div className="flex flex-wrap gap-1">
                {task.blocks.map((id) => (
                  <span
                    className="rounded bg-amber-500/10 px-1.5 py-0.5 text-amber-400"
                    key={id}
                  >
                    {getTaskSubject(id)}
                  </span>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ============================================================================
// Main Component
// ============================================================================

export function TaskListPanel({
  tasks,
  className,
  defaultExpanded = false,
}: TaskListPanelProps) {
  if (tasks.length === 0) {
    return (
      <div className={cn("rounded-lg border bg-[#1e2433] p-6", className)}>
        <p className="text-center text-gray-400 text-sm">No tasks found</p>
      </div>
    );
  }

  // Count tasks by status
  const statusCounts = tasks.reduce(
    (acc, task) => {
      acc[task.status] = (acc[task.status] || 0) + 1;
      return acc;
    },
    {} as Record<DaprAgentTaskStatus, number>
  );

  return (
    <div
      className={cn(
        "overflow-hidden rounded-lg border border-gray-700 bg-[#1e2433]",
        className
      )}
    >
      {/* Header */}
      <div className="flex items-center justify-between border-gray-700 border-b bg-[#1a1f2e] px-4 py-2">
        <span className="font-medium text-gray-300 text-sm">
          Tasks ({tasks.length})
        </span>
        <div className="flex items-center gap-3 text-xs">
          {statusCounts.completed && (
            <span className="text-green-400">
              {statusCounts.completed} completed
            </span>
          )}
          {statusCounts.in_progress && (
            <span className="text-blue-400">
              {statusCounts.in_progress} in progress
            </span>
          )}
          {statusCounts.pending && (
            <span className="text-gray-400">
              {statusCounts.pending} pending
            </span>
          )}
          {statusCounts.failed && (
            <span className="text-red-400">{statusCounts.failed} failed</span>
          )}
        </div>
      </div>

      {/* Task List */}
      <div className="max-h-[400px] overflow-y-auto">
        {tasks.map((task) => (
          <TaskItem
            allTasks={tasks}
            defaultExpanded={defaultExpanded}
            key={task.id}
            task={task}
          />
        ))}
      </div>
    </div>
  );
}
