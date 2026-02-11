export type ExecuteRequest = {
	step: string;
	execution_id: string;
	workflow_id: string;
	node_id: string;
	input: Record<string, unknown>;
	node_outputs?: Record<string, { label: string; data: unknown }>;
	credentials?: Record<string, string>;
};

export type ExecuteResponse = {
	success: boolean;
	data?: unknown;
	error?: string;
	duration_ms: number;
};
