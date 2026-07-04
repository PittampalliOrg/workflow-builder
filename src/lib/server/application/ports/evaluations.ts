export interface EvaluationRunCancellationPort {
	cancelEvaluationRun(projectId: string, runId: string): Promise<unknown>;
}

export type EvaluationDatasetRowRecord = {
	id: string;
	datasetId: string;
	externalId: string | null;
	input: Record<string, unknown>;
	expectedOutput: unknown;
	generatedOutput: unknown;
	annotations: Record<string, unknown>;
	rating: number | null;
	feedback: string | null;
	metadata: Record<string, unknown>;
	originRunInstanceId: string | null;
	originSessionId: string | null;
	createdAt: Date;
	updatedAt: Date;
};

export interface EvaluationArtifactStore {
	recordCodeCheckpointWarning(input: {
		workflowExecutionId: string;
		sourceEventId: string;
		checkpoint: Record<string, unknown>;
	}): Promise<void>;
}
