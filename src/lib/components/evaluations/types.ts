// Shared TypeScript types for evaluations UI components.
// Mirrors `getEvaluationRun` server-shape (src/lib/server/evaluations/service.ts).

export type RunStatus = 'queued' | 'running' | 'grading' | 'completed' | 'failed' | 'cancelled';

export type ItemStatus =
	| 'queued'
	| 'running'
	| 'grading'
	| 'passed'
	| 'failed'
	| 'error'
	| 'cancelled'
	| 'skipped';

export type GraderResult = {
	id?: string;
	name?: string;
	type?: string;
	score: number | null;
	passed: boolean;
	skipped?: boolean;
	error?: string | null;
	details?: unknown;
	children?: GraderResult[];
};

export type RunItem = {
	id: string;
	runId: string;
	rowIndex: number;
	status: ItemStatus;
	input: Record<string, unknown>;
	expectedOutput: unknown;
	generatedOutput: unknown;
	graderResults: Record<string, GraderResult>;
	scores: { score: number | null; passed: boolean };
	usage: Record<string, unknown> | null;
	traceIds: string[] | null;
	sessionId: string | null;
	workflowExecutionId: string | null;
	error: string | null;
	startedAt: string | null;
	completedAt: string | null;
	compact?: boolean;
};

export type RunDetail = {
	id: string;
	evaluationId: string;
	evaluationName: string | null;
	datasetId: string | null;
	datasetName: string | null;
	status: RunStatus;
	subjectType: string;
	subjectId: string | null;
	subjectVersion: string | null;
	summary: Record<string, number | string | null | Record<string, unknown>>;
	usage: Record<string, unknown> | null;
	error: string | null;
	startedAt: string | null;
	completedAt: string | null;
	createdAt: string;
	updatedAt: string;
	items: RunItem[];
	artifacts: Array<{ id: string; kind: string; path: string | null; createdAt: string }>;
};
