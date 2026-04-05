export type ActionKind =
	| 'catalog-function'
	| 'code-function'
	| 'dapr-activity'
	| 'dapr-workflow';

export type ActionVisibility = 'public-callable' | 'inspect-only';
export type ActionCompatibilityStatus =
	| 'compatible'
	| 'compatible-with-warnings'
	| 'inspect-only';

export interface ActionRuntimeStatus {
	registered: boolean;
	ready: boolean;
	lastSeenAt: string | null;
	errors: string[];
	features: string[];
}

export interface ActionSwProjection {
	functionName: string | null;
	definition: Record<string, unknown> | null;
	taskConfig: Record<string, unknown> | null;
	warnings: string[];
}

export interface ActionAuthMetadata {
	required: boolean;
	displayName: string | null;
	description: string | null;
	kinds: string[];
	authType?: string | null;
	connectionResourceType?: string | null;
}

export interface ActionFieldOption {
	label: string;
	value: unknown;
}

export interface ActionFieldMetadata {
	name: string;
	displayName: string;
	description: string | null;
	propertyType: string;
	schemaType: string;
	required: boolean;
	defaultValue: unknown | null;
	dependsOn: string[];
	refreshers: string[];
	refreshOnSearch: boolean;
	options:
		| {
				kind: 'static';
				values: ActionFieldOption[];
		  }
		| {
				kind: 'dynamic';
				refreshers: string[];
				refreshOnSearch: boolean;
		  }
		| null;
}

export interface ActionCatalogSummary {
	id: string;
	slug: string;
	name: string;
	displayName: string;
	description: string;
	providerId?: string | null;
	providerLabel?: string | null;
	providerIconUrl?: string | null;
	category?: string | null;
	serviceId: string;
	kind: ActionKind;
	visibility: ActionVisibility;
	compatibility: ActionCompatibilityStatus;
	group: string;
	version: string | null;
	language?: string | null;
	entrypoint?: string | null;
	sourceKind?: 'integration' | 'code' | 'activity' | 'workflow';
	service?: string;
	pieceName?: string;
	actionName?: string;
	functionRef?: Record<string, unknown> | null;
	insertable: boolean;
	tags: string[];
	runtime: ActionRuntimeStatus;
}

export interface ActionCatalogDetail extends ActionCatalogSummary {
	doc?: string | null;
	inputSchema?: Record<string, unknown> | null;
	outputSchema?: Record<string, unknown> | null;
	semanticModel?: Record<string, unknown> | null;
	auth?: ActionAuthMetadata | null;
	fields?: ActionFieldMetadata[] | null;
	sourceCode?: string | null;
	sourceHtml?: string | null;
	rendered?: {
		inputSchemaHtml?: string | null;
		outputSchemaHtml?: string | null;
		definitionHtml?: string | null;
		rawHtml?: string | null;
	} | null;
	sw: ActionSwProjection;
	raw?: Record<string, unknown> | null;
}

export interface ActionCatalogServiceSnapshot {
	service: string;
	version: string;
	runtime: string;
	ready: boolean;
	features: string[];
	registeredWorkflows: Array<{
		id: string;
		name: string;
		version: string | null;
		aliases: string[];
		isLatest: boolean;
		service: string;
		source: string;
	}>;
	registeredActivities: Array<{
		id: string;
		name: string;
		displayName: string;
		description: string;
		doc: string | null;
		sourceCode: string | null;
		sourceHtml: string | null;
	}>;
	additional: Record<string, unknown>;
}

export interface ActionCatalogSnapshot {
	timestamp: string;
	sourceMode: 'unified';
	services: ActionCatalogServiceSnapshot[];
	items: Array<Record<string, unknown>>;
	partialErrors: { serviceId: string; error: string }[];
	error: string | null;
}
