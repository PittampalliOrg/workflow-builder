export type DaprDashboardPlatform =
	| "kubernetes"
	| "standalone"
	| "docker-compose"
	| "unknown";

export type DaprDebugSourceStatus = {
	ok: boolean;
	error?: string;
};

export type DaprControlPlaneEntry = {
	service: string;
	name: string;
	namespace: string;
	healthy: string;
	status: string;
	version: string;
	age: string;
	created: string;
};

export type DaprDashboardInstance = {
	appId: string;
	httpPort: number;
	grpcPort: number;
	appPort: number;
	command: string;
	age: string;
	created: string;
	pid: number;
	replicas: number;
	address: string;
	supportsDeletion: boolean;
	supportsLogs: boolean;
	manifest: string;
	status: string;
	labels: string;
	selector: string;
	config: string;
	scope: string;
};

export type DaprMetadataActor = {
	type: string;
	count: number;
};

export type DaprMetadataComponent = {
	name: string;
	type: string;
	version: string;
	capabilities: string[];
};

export type DaprMetadataSubscription = {
	pubsubName: string;
	topic: string;
	deadLetterTopic: string;
	metadata: Record<string, unknown> | null;
	rules: Array<Record<string, unknown>>;
};

export type DaprDashboardMetadata = {
	id: string;
	runtimeVersion: string;
	enabledFeatures: string[];
	actors: DaprMetadataActor[];
	components: DaprMetadataComponent[];
	subscriptions: DaprMetadataSubscription[];
	extended: Record<string, unknown>;
};

export type DaprDashboardComponent = {
	name: string;
	kind: string;
	type: string;
	created: string;
	age: string;
	scopes: string[];
	manifest: Record<string, unknown> | null;
};

export type DaprDashboardConfiguration = {
	name: string;
	kind: string;
	created: string;
	age: string;
	tracingEnabled: boolean;
	samplingRate: string;
	metricsEnabled: boolean;
	mtlsEnabled: boolean;
	mtlsWorkloadTTL: string;
	mtlsClockSkew: string;
	manifest: Record<string, unknown> | string | null;
};

export type WorkflowRuntimeRegistration = {
	name: string;
	version?: string | null;
	aliases?: string[];
	isLatest?: boolean;
	source: "service-introspection";
};

export type WorkflowActivityRegistration = {
	name: string;
	source: "service-introspection";
};

export type DaprRuntimeIntrospection = {
	service: string;
	version: string;
	runtime: string;
	ready: boolean;
	runtimeStatus: Record<string, unknown>;
	features: string[];
	registeredWorkflows: WorkflowRuntimeRegistration[];
	registeredActivities: WorkflowActivityRegistration[];
	errors: string[];
	registry?: {
		enabled: boolean;
		storeName?: string | null;
		teamName?: string | null;
		registeredAgents?: Array<{
			name: string;
			metadata: Record<string, unknown>;
		}>;
	};
	additional?: Record<string, unknown>;
};

export type DaprDebugRecentRun = {
	instanceId: string;
	workflowId: string;
	workflowName?: string;
	workflowVersion?: string | null;
	workflowNameVersioned?: string | null;
	runtimeStatus: string;
	phase?: string;
	progress: number;
	message?: string;
	currentNodeName?: string | null;
	startedAt?: string;
	completedAt?: string | null;
};

export type DaprDebugAgentSummary = {
	id: string;
	name: string;
	agentType: string;
	model: {
		provider: string;
		name: string;
	};
	isEnabled: boolean;
	updatedAt: string;
};

export type DaprDebugOverviewResponse = {
	sources: {
		dashboard: DaprDebugSourceStatus;
		workflowOrchestrator: DaprDebugSourceStatus;
		durableAgent: DaprDebugSourceStatus;
		applicationAgents: DaprDebugSourceStatus;
	};
	dashboard: {
		baseUrl?: string;
		platform: DaprDashboardPlatform;
		scopes: string[];
		controlPlane: DaprControlPlaneEntry[];
	};
	instances: DaprDashboardInstance[];
	components: DaprDashboardComponent[];
	configurations: DaprDashboardConfiguration[];
	workflowRuntime: {
		orchestrator: DaprRuntimeIntrospection | null;
		durableAgent: DaprRuntimeIntrospection | null;
		recentRuns: DaprDebugRecentRun[];
	};
	agents: {
		application: DaprDebugAgentSummary[];
		runtimeRegistry: Array<{
			name: string;
			metadata: Record<string, unknown>;
			sourceApp: string;
		}>;
	};
};

export type DaprDebugAppDetailResponse = {
	appId: string;
	sourceStatus: {
		dashboard: DaprDebugSourceStatus;
		introspection: DaprDebugSourceStatus;
	};
	instance: DaprDashboardInstance | null;
	metadata: DaprDashboardMetadata | null;
	introspection: DaprRuntimeIntrospection | null;
};
