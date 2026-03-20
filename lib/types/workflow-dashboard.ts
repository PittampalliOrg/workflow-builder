/**
 * Types for the Workflow Dashboard (Diagrid Catalyst-style views)
 */

import type { WorkflowUIStatus } from "./workflow-ui";

/**
 * Summary row for the workflow names list view.
 * Groups executions by workflow name.
 */
export type WorkflowNameSummary = {
	name: string;
	appId: string;
	totalExecutions: number;
	running: number;
	success: number;
	failed: number;
};

/**
 * Response from GET /api/workflows/names
 */
export type WorkflowNamesResponse = {
	workflows: WorkflowNameSummary[];
	totalRows: number;
};

/**
 * Execution summary for the detail page's "Latest executions" list.
 */
export type WorkflowExecutionSummary = {
	instanceId: string;
	status: WorkflowUIStatus;
	startTime: string;
	endTime: string | null;
	executionTime: string | null;
};

/**
 * Response from GET /api/workflows/names/[appId]/[workflowName]
 */
export type WorkflowNameDetail = {
	name: string;
	appId: string;
	totalExecutions: number;
	running: number;
	success: number;
	failed: number;
	successRate: number;
	executions: WorkflowExecutionSummary[];
};

/**
 * History event for the execution detail timeline.
 */
export type WorkflowHistoryEvent = {
	eventId: number | null;
	eventType: string;
	name: string | null;
	timestamp: string;
	input?: unknown;
	output?: unknown;
};

/**
 * Full execution detail response.
 */
export type WorkflowExecutionDetail = {
	instanceId: string;
	workflowName: string;
	appId: string;
	status: WorkflowUIStatus;
	startTime: string;
	endTime: string | null;
	executionTime: string | null;
	input: unknown;
	output: unknown;
	history: WorkflowHistoryEvent[];
	error?: string | null;
};

/**
 * Row in the flat "All workflow executions" table.
 */
export type AllExecutionRow = {
	instanceId: string;
	status: WorkflowUIStatus;
	workflowName: string;
	appId: string;
	startTime: string;
	executionTime: string | null;
};

/**
 * Response from GET /api/workflows/executions/all
 */
export type AllExecutionsResponse = {
	executions: AllExecutionRow[];
	totalRows: number;
};
