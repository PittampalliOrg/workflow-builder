import * as db from "../db.js";
import type { WorkflowPersistencePort } from "../ports/workflow-persistence.js";

/** PostgreSQL adapter for the workflow MCP persistence boundary. */
export class PostgresWorkflowPersistenceAdapter implements WorkflowPersistencePort {
  listWorkflows(projectId: string, limit?: number) {
    return db.listWorkflows(projectId, limit);
  }

  findWorkflow(ref: string, projectId: string) {
    return db.getScopedWorkflow(ref, projectId);
  }

  listAvailableActions(search?: string) {
    return db.listAvailableActions(search);
  }

  findExecution(ref: string, projectId: string) {
    return db.getExecutionByInstanceId(ref, projectId);
  }

  listExecutionLogs(executionId: string) {
    return db.getExecutionLogs(executionId);
  }
}
