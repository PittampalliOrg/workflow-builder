"use client";

import { useState } from "react";
import {
  ChevronDown,
  ChevronRight,
  Circle,
  CheckCircle2,
  Loader2,
  XCircle,
} from "lucide-react";
import { cn } from "@/lib/utils";
import type {
  DaprAgentTask,
  DaprAgentTaskStatus,
} from "@/lib/types/workflow-ui";
import {
  getTaskStatusColor,
  getTaskStatusBgColor,
} from "@/lib/types/workflow-ui";

// ============================================================================
// Types
// ============================================================================

interface TaskListPanelProps {
  tasks: DaprAgentTask[];
  className?: string;
  defaultExpanded?: boolean;
}

interface TaskItemProps {
  task: DaprAgentTask;
  allTasks: DaprAgentTask[];
  defaultExpanded?: boolean;
}

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
    task.description ||
    task.blockedBy.length > 0 ||
    task.blocks.length > 0;

  return (
    <div className="border-b border-gray-700 last:border-b-0">
      {/* Task Header */}
      <div
        className={cn(
          "flex items-center gap-3 px-4 py-3 transition-colors",
          hasDetails && "cursor-pointer hover:bg-gray-800/50"
        )}
        onClick={() => hasDetails && setExpanded(!expanded)}
      >
        {/* Expand Icon */}
        {hasDetails ? (
          expanded ? (
            <ChevronDown className="h-4 w-4 text-gray-400 shrink-0" />
          ) : (
            <ChevronRight className="h-4 w-4 text-gray-400 shrink-0" />
          )
        ) : (
          <div className="w-4 shrink-0" />
        )}

        {/* Status Icon */}
        <TaskStatusIcon status={task.status} />

        {/* Task ID & Subject */}
        <div className="flex-1 min-w-0">
          <span className="text-sm font-medium text-gray-300">
            #{task.id}
          </span>
          <span className="mx-2 text-gray-500">·</span>
          <span className="text-sm text-gray-200 truncate">
            {task.subject}
          </span>
        </div>

        {/* Status Badge */}
        <span
          className={cn(
            "px-2 py-0.5 text-xs rounded-full shrink-0",
            getTaskStatusBgColor(task.status),
            getTaskStatusColor(task.status)
          )}
        >
          {task.status.replace("_", " ")}
        </span>
      </div>

      {/* Expanded Details */}
      {expanded && hasDetails && (
        <div className="px-4 pb-3 pl-11 space-y-2">
          {/* Description */}
          {task.description && (
            <p className="text-sm text-gray-400 whitespace-pre-wrap">
              {task.description}
            </p>
          )}

          {/* Dependencies */}
          {task.blockedBy.length > 0 && (
            <div className="flex items-start gap-2 text-xs">
              <span className="text-gray-500 shrink-0">blockedBy:</span>
              <div className="flex flex-wrap gap-1">
                {task.blockedBy.map((id) => (
                  <span
                    key={id}
                    className="px-1.5 py-0.5 bg-red-500/10 text-red-400 rounded"
                  >
                    {getTaskSubject(id)}
                  </span>
                ))}
              </div>
            </div>
          )}

          {task.blocks.length > 0 && (
            <div className="flex items-start gap-2 text-xs">
              <span className="text-gray-500 shrink-0">blocks:</span>
              <div className="flex flex-wrap gap-1">
                {task.blocks.map((id) => (
                  <span
                    key={id}
                    className="px-1.5 py-0.5 bg-amber-500/10 text-amber-400 rounded"
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
        <p className="text-sm text-gray-400 text-center">No tasks found</p>
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
        "rounded-lg border border-gray-700 bg-[#1e2433] overflow-hidden",
        className
      )}
    >
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-2 border-b border-gray-700 bg-[#1a1f2e]">
        <span className="text-sm font-medium text-gray-300">
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
            key={task.id}
            task={task}
            allTasks={tasks}
            defaultExpanded={defaultExpanded}
          />
        ))}
      </div>
    </div>
  );
}
