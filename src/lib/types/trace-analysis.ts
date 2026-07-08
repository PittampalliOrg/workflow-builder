/**
 * Deep trace-analysis contract — the structured quality report produced by
 * the `trace-deep-analysis` dynamic-script workflow (multi-agent lens reviews
 * → schema'd synthesis). Shared boundary type: produced by the workflow run,
 * consumed by the report sheet + the improvement apply flow.
 */

export type TraceAnalysisLens = 'performance' | 'cost' | 'reliability' | 'quality';

export type TraceAnalysisFinding = {
	lens: TraceAnalysisLens;
	severity: 'info' | 'low' | 'medium' | 'high';
	title: string;
	detail: string;
	evidence: string[];
};

export type TraceAnalysisImprovement = {
	title: string;
	rationale: string;
	impact: 'high' | 'medium' | 'low';
	/** 'script' improvements carry a complete revised script to apply. */
	kind: 'script' | 'config' | 'suggestion';
	revisedScript: string | null;
};

export type TraceAnalysisReport = {
	summary: string;
	healthScore: number;
	findings: TraceAnalysisFinding[];
	improvements: TraceAnalysisImprovement[];
};

export type DeepAnalysisStart = {
	analysisExecutionId: string;
	targetWorkflowId: string | null;
	targetWorkflowName: string | null;
};
