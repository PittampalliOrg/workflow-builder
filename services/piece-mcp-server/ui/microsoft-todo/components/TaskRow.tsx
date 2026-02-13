import type { Task } from "../App";

interface Props {
  task: Task;
  onSelect: (task: Task) => void;
  onComplete: (task: Task) => void;
}

function getDueDateInfo(task: Task): { label: string; className: string } | null {
  if (!task.dueDateTime?.dateTime) return null;
  const due = new Date(task.dueDateTime.dateTime);
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const dueDay = new Date(due.getFullYear(), due.getMonth(), due.getDate());
  const diffDays = Math.round((dueDay.getTime() - today.getTime()) / (1000 * 60 * 60 * 24));

  const label = dueDay.toLocaleDateString(undefined, { month: "short", day: "numeric" });

  if (diffDays < 0) return { label: `Overdue: ${label}`, className: "badge-overdue" };
  if (diffDays === 0) return { label: `Today`, className: "badge-today" };
  if (diffDays === 1) return { label: `Tomorrow`, className: "badge-upcoming" };
  return { label, className: "badge-default" };
}

function getImportanceIcon(importance: string) {
  if (importance === "high") {
    return (
      <span className="importance-high" title="High importance">
        <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
          <path d="M8 2l1.5 4H14l-3.5 3 1.5 5L8 11 4 14l1.5-5L2 6h4.5z" fill="currentColor" />
        </svg>
      </span>
    );
  }
  return null;
}

export function TaskRow({ task, onSelect, onComplete }: Props) {
  const isCompleted = task.status === "completed";
  const dueInfo = getDueDateInfo(task);

  return (
    <div className={`task-row ${isCompleted ? "completed" : ""}`}>
      <button
        className={`checkbox ${isCompleted ? "checked" : ""}`}
        onClick={(e) => {
          e.stopPropagation();
          if (!isCompleted) onComplete(task);
        }}
        title={isCompleted ? "Completed" : "Mark complete"}
      >
        {isCompleted && (
          <svg width="12" height="12" viewBox="0 0 16 16" fill="none">
            <path d="M3 8l3.5 3.5L13 5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        )}
      </button>
      <div className="task-content" onClick={() => onSelect(task)}>
        <span className={`task-title ${isCompleted ? "strikethrough" : ""}`}>
          {task.title}
        </span>
        <div className="task-meta">
          {getImportanceIcon(task.importance)}
          {dueInfo && (
            <span className={`badge ${dueInfo.className}`}>{dueInfo.label}</span>
          )}
          {task.categories && task.categories.length > 0 && (
            <span className="badge badge-category">
              {task.categories[0]}
            </span>
          )}
        </div>
      </div>
    </div>
  );
}
