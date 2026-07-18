import type { WorkflowMcpSessionOwner } from "./ports/workflow-mcp-auth";

const TERMINAL_SESSION_STATUSES = new Set([
  "terminated",
  "completed",
  "cancelled",
  "canceled",
  "crashed",
]);

export function workflowMcpSessionIsTerminal(
  owner: WorkflowMcpSessionOwner,
): boolean {
  return (
    Boolean(owner.status && TERMINAL_SESSION_STATUSES.has(owner.status)) ||
    (owner.status === "failed" && owner.completedAt != null)
  );
}
