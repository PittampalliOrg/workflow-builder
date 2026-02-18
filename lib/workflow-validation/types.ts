export type ContractIssueSeverity = "error" | "warning";

export type ContractIssueCode =
	| "BROKEN_REFERENCE"
	| "NON_UPSTREAM_REFERENCE"
	| "MAYBE_UNSET_REFERENCE"
	| "UNKNOWN_OUTPUT_FIELD"
	| "UNKNOWN_ACTION_TYPE"
	| "TYPE_COMPAT_WARNING"
	| "OTHER";

export type ContractIssue = {
	code: ContractIssueCode;
	severity: ContractIssueSeverity;
	message: string;
	path: string;
	nodeId?: string;
	edgeId?: string;
};

export type EdgeValidationState = "valid" | "warning" | "invalid";

export type ContextAvailability = "always" | "maybe";

export type UpstreamContextNode = {
	nodeId: string;
	nodeLabel: string;
	nodeType: string;
	availability: ContextAvailability;
};

export type AvailableContextForNode = {
	upstreamNodes: UpstreamContextNode[];
	stateKeys: string[];
	triggerNodeId?: string;
};

export type AvailableContextByNodeId = Record<string, AvailableContextForNode>;

export type WorkflowValidationSnapshot = {
	issues: ContractIssue[];
	issuesByNodeId: Record<string, ContractIssue[]>;
	edgeStates: Record<string, EdgeValidationState>;
	availableContextByNodeId: AvailableContextByNodeId;
};
