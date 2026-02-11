/**
 * Type definitions for Function Router
 */

/**
 * Function registry entry - maps function slugs to target services
 */
export type FunctionRegistryEntry = {
	/** Dapr app-id of the target service */
	appId: string;
	/**
	 * Type of service:
	 * - "knative": scale-to-zero Knative service (preferred)
	 * - "openfunction": legacy alias accepted for backward compatibility
	 */
	type: "knative" | "openfunction";
};

/**
 * Function registry - loaded from ConfigMap
 */
export type FunctionRegistry = {
	[slug: string]: FunctionRegistryEntry;
};

/**
 * Execute request from workflow-orchestrator
 */
export type ExecuteRequest = {
	function_id?: string;
	function_slug?: string;
	execution_id: string;
	workflow_id: string;
	node_id: string;
	node_name: string;
	input: Record<string, unknown>;
	node_outputs?: NodeOutputs;
	integration_id?: string;
	integrations?: Record<string, Record<string, string>>;
	db_execution_id?: string;
	connection_external_id?: string;
	ap_project_id?: string;
	ap_platform_id?: string;
};

/**
 * Node outputs from upstream nodes
 */
export type NodeOutput = {
	label: string;
	data: unknown;
};

export type NodeOutputs = Record<string, NodeOutput>;

/**
 * Execute response
 */
export type ExecuteResponse = {
	success: boolean;
	data?: unknown;
	error?: string;
	duration_ms: number;
	routed_to?: string;
	/** Pause metadata from fn-activepieces when a piece requests DELAY or WEBHOOK pause */
	pause?: {
		type: "DELAY" | "WEBHOOK";
		resumeDateTime?: string;
		requestId?: string;
		response?: unknown;
	};
};

/**
 * Knative function request format
 */
export type OpenFunctionRequest = {
	step: string;
	execution_id: string;
	workflow_id: string;
	node_id: string;
	input: Record<string, unknown>;
	node_outputs?: NodeOutputs;
	credentials?: Record<string, string>;
	/** Raw AP connection value for fn-activepieces (OAuth2/SecretText/etc.) */
	credentials_raw?: unknown;
	/** Piece metadata for fn-activepieces routing */
	metadata?: { pieceName: string; actionName: string };
};

/**
 * Credential mappings for integration types
 */
export const SECRET_MAPPINGS: Record<string, Record<string, string>> = {
	openai: { OPENAI_API_KEY: "OPENAI-API-KEY" },
	anthropic: { ANTHROPIC_API_KEY: "ANTHROPIC-API-KEY" },
	slack: { SLACK_BOT_TOKEN: "SLACK-BOT-TOKEN" },
	resend: { RESEND_API_KEY: "RESEND-API-KEY" },
	github: { GITHUB_TOKEN: "GITHUB-TOKEN" },
	linear: { LINEAR_API_KEY: "LINEAR-API-KEY" },
	stripe: { STRIPE_SECRET_KEY: "STRIPE-SECRET-KEY" },
	firecrawl: { FIRECRAWL_API_KEY: "FIRECRAWL-API-KEY" },
	perplexity: { PERPLEXITY_API_KEY: "PERPLEXITY-API-KEY" },
	clerk: { CLERK_SECRET_KEY: "CLERK-SECRET-KEY" },
	fal: { FAL_KEY: "FAL-API-KEY" },
	webflow: { WEBFLOW_API_TOKEN: "WEBFLOW-API-TOKEN" },
	superagent: { SUPERAGENT_API_KEY: "SUPERAGENT-API-KEY" },
};
