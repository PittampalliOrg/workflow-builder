import {
	getApplicationAdapterConfig,
	type ApplicationAdapterConfig,
} from "$lib/server/application/config";
import {
	PostgresArtifactStore,
	PostgresTraceLineageStore,
	PostgresWorkflowAgentRunStore,
	PostgresWorkspaceSessionStore,
	PostgresWorkflowPlanArtifactStore,
	PostgresWorkflowDefinitionRepository,
	PostgresWorkflowExecutionRepository,
	requirePostgresDb,
} from "$lib/server/application/adapters/postgres";
import {
	DaprCredentialStore,
	DaprEventBus,
	DaprWorkflowScheduler,
} from "$lib/server/application/adapters/dapr";
import {
	KroPreviewEnvironmentProvisioner,
	SandboxExecutionPreviewEnvironmentProvisioner,
} from "$lib/server/application/adapters/preview";
import { WorkspaceRuntimeSandboxProvisioner } from "$lib/server/application/adapters/sandbox";
import {
	CurrentSessionRepository,
	PostgresSessionEventLog,
} from "$lib/server/application/adapters/sessions";
import { getEventBusAdapter } from "$lib/server/application/event-bus";
import { ApplicationWorkflowDataService } from "$lib/server/application/workflow-data";

export { getEventBusAdapter } from "$lib/server/application/event-bus";

export function getApplicationAdapters(
	config: ApplicationAdapterConfig = getApplicationAdapterConfig(),
) {
	if (config.persistenceAdapter !== "postgres") {
		throw new Error(`Unsupported persistence adapter: ${config.persistenceAdapter}`);
	}
	if (config.artifactStoreAdapter !== "postgres-metadata-object-data") {
		throw new Error(`Unsupported artifact store adapter: ${config.artifactStoreAdapter}`);
	}
	if (config.workflowSchedulerAdapter !== "dapr-workflow") {
		throw new Error(`Unsupported workflow scheduler adapter: ${config.workflowSchedulerAdapter}`);
	}
	if (config.eventBusAdapter !== "dapr-pubsub") {
		throw new Error(`Unsupported event bus adapter: ${config.eventBusAdapter}`);
	}

	let database: ReturnType<typeof requirePostgresDb> | undefined;
	let workflowDefinitions: PostgresWorkflowDefinitionRepository | undefined;
	let workflowExecutions: PostgresWorkflowExecutionRepository | undefined;
	let artifactStore: PostgresArtifactStore | undefined;
	let workspaceSessions: PostgresWorkspaceSessionStore | undefined;
	let agentRuns: PostgresWorkflowAgentRunStore | undefined;
	let planArtifacts: PostgresWorkflowPlanArtifactStore | undefined;
	let traceLineage: PostgresTraceLineageStore | undefined;
	let workflowData: ApplicationWorkflowDataService | undefined;
	const getDatabase = () => (database ??= requirePostgresDb());
	const getWorkflowDefinitions = () =>
		(workflowDefinitions ??= new PostgresWorkflowDefinitionRepository(getDatabase()));
	const getWorkflowExecutions = () =>
		(workflowExecutions ??= new PostgresWorkflowExecutionRepository(getDatabase()));
	const getArtifactStore = () =>
		(artifactStore ??= new PostgresArtifactStore(getDatabase()));
	const getWorkspaceSessions = () =>
		(workspaceSessions ??= new PostgresWorkspaceSessionStore(getDatabase()));
	const getAgentRuns = () =>
		(agentRuns ??= new PostgresWorkflowAgentRunStore(getDatabase()));
	const getPlanArtifacts = () =>
		(planArtifacts ??= new PostgresWorkflowPlanArtifactStore(getDatabase()));
	const getTraceLineage = () =>
		(traceLineage ??= new PostgresTraceLineageStore(getDatabase()));
	const previewEnvironmentProvisioner =
		config.previewProvisionerAdapter === "kro"
			? new KroPreviewEnvironmentProvisioner()
			: new SandboxExecutionPreviewEnvironmentProvisioner();
	return {
		config,
		get workflowDefinitions() {
			return getWorkflowDefinitions();
		},
		get workflowExecutions() {
			return getWorkflowExecutions();
		},
		get artifactStore() {
			return getArtifactStore();
		},
		get workflowData() {
			return (workflowData ??= new ApplicationWorkflowDataService({
				workflowDefinitions: getWorkflowDefinitions(),
				workflowExecutions: getWorkflowExecutions(),
				artifactStore: getArtifactStore(),
				workspaceSessions: getWorkspaceSessions(),
				agentRuns: getAgentRuns(),
				planArtifacts: getPlanArtifacts(),
				traceLineage: getTraceLineage(),
			}));
		},
		workflowScheduler: new DaprWorkflowScheduler(),
		eventBus: getEventBusAdapter(config),
		credentialStore: new DaprCredentialStore(),
		sessions: new CurrentSessionRepository(),
		sessionEvents: new PostgresSessionEventLog(),
		sandboxProvisioner: new WorkspaceRuntimeSandboxProvisioner(),
		previewEnvironmentProvisioner,
	};
}
