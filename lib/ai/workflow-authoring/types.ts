export type WorkflowGenerationComplexity =
	| "simple"
	| "standard"
	| "multi_agent";

export type WorkflowGenerationInput = {
	prompt: string;
	name?: string;
	description?: string;
	complexity?: WorkflowGenerationComplexity;
	requiresPullRequest?: boolean;
	preferAvailableMcp?: boolean;
	repoOwner?: string;
	repoName?: string;
	issueNumber?: number | null;
};

export type WorkflowGenerationDraftSettings = {
	complexity: WorkflowGenerationComplexity;
	requiresPullRequest: boolean;
	preferAvailableMcp: boolean;
	repoOwner: string;
	repoName: string;
	issueNumber: string;
};

export type WorkflowAuthoringCapability = {
	sourceType: string;
	key: string;
	displayName: string;
	description: string | null;
};

export type WorkflowAuthoringFunctionMetadata = {
	name: string;
	label: string;
	category: string;
	description: string;
	whenToUse: string;
	avoidWhen: string;
	requiredInputs: string[];
	outputs: string[];
	examplePayload?: Record<string, unknown>;
	longRunning: boolean;
	idempotent: boolean;
};

export type WorkflowAuthoringExample = {
	name: string;
	intent: string;
	workflow: string;
};

export type WorkflowAuthoringContextPayload = {
	guide: string;
	examples: WorkflowAuthoringExample[];
	functions: WorkflowAuthoringFunctionMetadata[];
	capabilities: WorkflowAuthoringCapability[];
};

export type WorkflowAuthoringDiagnostics = {
	errors: Array<{ message: string; path?: string; code?: string }>;
	warnings: Array<{ message: string; code?: string }>;
	repairActions?: string[];
	unsupportedRequirements?: string[];
};
