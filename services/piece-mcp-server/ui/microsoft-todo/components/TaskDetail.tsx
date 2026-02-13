import { useState, useEffect } from "react";
import type { TodoApi } from "../hooks/useTodoApi";
import type { Task } from "../App";

interface Props {
  api: TodoApi;
  listId: string;
  task: Task;
  onClose: () => void;
  onUpdate: () => void;
}

export function TaskDetail({ api, listId, task, onClose, onUpdate }: Props) {
  const [title, setTitle] = useState(task.title);
  const [body, setBody] = useState(task.body?.content ?? "");
  const [importance, setImportance] = useState(task.importance ?? "normal");
  const [dueDate, setDueDate] = useState(
    task.dueDateTime?.dateTime?.split("T")[0] ?? "",
  );
  const [startDate, setStartDate] = useState(
    task.startDateTime?.dateTime?.split("T")[0] ?? "",
  );
  const [reminderDate, setReminderDate] = useState(
    task.reminderDateTime?.dateTime?.split("T")[0] ?? "",
  );
  const [categories, setCategories] = useState(
    task.categories?.join(", ") ?? "",
  );
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);

  useEffect(() => {
    setTitle(task.title);
    setBody(task.body?.content ?? "");
    setImportance(task.importance ?? "normal");
    setDueDate(task.dueDateTime?.dateTime?.split("T")[0] ?? "");
    setStartDate(task.startDateTime?.dateTime?.split("T")[0] ?? "");
    setReminderDate(task.reminderDateTime?.dateTime?.split("T")[0] ?? "");
    setCategories(task.categories?.join(", ") ?? "");
    setConfirmDelete(false);
  }, [task]);

  const handleSave = async () => {
    setSaving(true);
    try {
      const fields: Record<string, unknown> = { title };
      if (body) fields.body_content = body;
      fields.importance = importance;
      if (dueDate) fields.due_date_time = dueDate;
      if (startDate) fields.start_date_time = startDate;
      if (reminderDate) fields.reminder_date_time = reminderDate;
      if (categories.trim()) {
        fields.categories = categories
          .split(",")
          .map((c) => c.trim())
          .filter(Boolean)
          .join(",");
      }
      await api.updateTask(listId, task.id, fields);
      onUpdate();
    } catch (err) {
      console.error("Failed to update task:", err);
    } finally {
      setSaving(false);
    }
  };

  const handleComplete = async () => {
    try {
      await api.completeTask(listId, task.id);
      onUpdate();
      onClose();
    } catch (err) {
      console.error("Failed to complete task:", err);
    }
  };

  const handleDelete = async () => {
    if (!confirmDelete) {
      setConfirmDelete(true);
      return;
    }
    setDeleting(true);
    try {
      await api.deleteTask(listId, task.id);
      onUpdate();
      onClose();
    } catch (err) {
      console.error("Failed to delete task:", err);
    } finally {
      setDeleting(false);
    }
  };

  const isCompleted = task.status === "completed";

  return (
    <aside className="detail-panel">
      <div className="detail-header">
        <h3>Task Details</h3>
        <button className="btn-icon" onClick={onClose} title="Close">
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
            <path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
          </svg>
        </button>
      </div>
      <div className="detail-body">
        <div className="field">
          <label htmlFor="detail-title">Title</label>
          <input
            id="detail-title"
            type="text"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
          />
        </div>

        <div className="field">
          <label htmlFor="detail-body">Notes</label>
          <textarea
            id="detail-body"
            value={body}
            onChange={(e) => setBody(e.target.value)}
            rows={4}
          />
        </div>

        <div className="field">
          <label htmlFor="detail-importance">Importance</label>
          <select
            id="detail-importance"
            value={importance}
            onChange={(e) => setImportance(e.target.value)}
          >
            <option value="low">Low</option>
            <option value="normal">Normal</option>
            <option value="high">High</option>
          </select>
        </div>

        <div className="field">
          <label htmlFor="detail-due">Due Date</label>
          <input
            id="detail-due"
            type="date"
            value={dueDate}
            onChange={(e) => setDueDate(e.target.value)}
          />
        </div>

        <div className="field">
          <label htmlFor="detail-start">Start Date</label>
          <input
            id="detail-start"
            type="date"
            value={startDate}
            onChange={(e) => setStartDate(e.target.value)}
          />
        </div>

        <div className="field">
          <label htmlFor="detail-reminder">Reminder</label>
          <input
            id="detail-reminder"
            type="date"
            value={reminderDate}
            onChange={(e) => setReminderDate(e.target.value)}
          />
        </div>

        <div className="field">
          <label htmlFor="detail-categories">Categories</label>
          <input
            id="detail-categories"
            type="text"
            placeholder="comma-separated"
            value={categories}
            onChange={(e) => setCategories(e.target.value)}
          />
        </div>

        {isCompleted && task.completedDateTime?.dateTime && (
          <div className="completed-info">
            Completed on{" "}
            {new Date(task.completedDateTime.dateTime).toLocaleDateString()}
          </div>
        )}
      </div>

      <div className="detail-actions">
        <button
          className="btn-primary"
          onClick={handleSave}
          disabled={saving || !title.trim()}
        >
          {saving ? "Saving..." : "Save"}
        </button>
        {!isCompleted && (
          <button className="btn-secondary" onClick={handleComplete}>
            Complete
          </button>
        )}
        <button
          className={`btn-danger ${confirmDelete ? "confirm" : ""}`}
          onClick={handleDelete}
          disabled={deleting}
        >
          {deleting
            ? "Deleting..."
            : confirmDelete
              ? "Confirm Delete?"
              : "Delete"}
        </button>
      </div>
    </aside>
  );
}
