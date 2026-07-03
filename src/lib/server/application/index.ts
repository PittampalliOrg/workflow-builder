import {
	getApplicationAdapterConfig,
	type ApplicationAdapterConfig,
} from "$lib/server/application/config";
import {
	PostgresArtifactStore,
	PostgresAdminPieceRepository,
	PostgresAgentRuntimeRepository,
	PostgresAppConnectionRepository,
	PostgresApiKeyStore,
	PostgresBenchmarkArtifactMetadataRepository,
	PostgresBenchmarkBrowserRepository,
	PostgresBenchmarkDatasetPromotionRepository,
	PostgresBenchmarkEvaluationResultRepository,
	PostgresBenchmarkInstanceDetailReadRepository,
	PostgresBenchmarkRunInstanceAnnotationRepository,
	PostgresBenchmarkRunInstanceDetailReadRepository,
	PostgresBenchmarkRunInstanceProgressReadRepository,
	PostgresBenchmarkRunInstanceScoreReadRepository,
	PostgresBenchmarkRunRepository,
	PostgresCodeFunctionCatalogRepository,
	PostgresDashboardReadRepository,
	PostgresEvaluationArtifactStore,
	PostgresGoalFlowReadStore,
	PostgresHomePageReadRepository,
	PostgresHostedMcpServerRepository,
	PostgresMcpConnectionRepository,
	PostgresMcpRunRepository,
	PostgresObservabilityTraceRepository,
	PostgresPieceExecutionRepository,
	PostgresPieceCatalogRepository,
	PostgresResourceUsageReadRepository,
	PostgresSandboxInventoryRepository,
	PostgresSecurityAuditReadRepository,
	PostgresSettingsRepository,
	PostgresTraceLineageStore,
	PostgresUsageReportingRepository,
	PostgresUserProfileRepository,
	PostgresWorkflowAgentRunStore,
	PostgresWorkflowActivityRateTargetRepository,
	PostgresWorkflowAiAssistantMessageRepository,
	PostgresWorkflowBrowserArtifactStore,
	PostgresWorkflowCodeCheckpointStore,
	PostgresWorkspaceSessionStore,
	PostgresWorkflowPlanArtifactStore,
	PostgresWorkflowDefinitionRepository,
	PostgresWorkflowExecutionRepository,
	PostgresWorkflowFileStore,
	PostgresWorkflowMonitorReadRepository,
	PostgresWorkflowSessionEventNotificationSource,
	PostgresWorkflowTriggerStore,
	PostgresWorkspaceProjectRepository,
	requirePostgresDb,
} from "$lib/server/application/adapters/postgres";
import { KubernetesAgentRuntimeWarmPoolClient } from "$lib/server/application/adapters/agent-runtime-control";
import {
	DaprBenchmarkEvaluationEventNotifier,
	LegacyBenchmarkEvaluationTelemetryAdapter,
	LegacyBenchmarkRunLifecycleAdapter,
} from "$lib/server/application/adapters/benchmark-evaluation-results";
import { RegistryPeerAgentResolver } from "$lib/server/application/adapters/agents";
import {
	DaprCredentialStore,
	DaprEventBus,
	DaprWorkflowScheduler,
} from "$lib/server/application/adapters/dapr";
import { LegacyBenchmarkRunReadRepository } from "$lib/server/application/adapters/benchmark-runs";
import { LegacyDevEnvironmentReadRepository } from "$lib/server/application/adapters/dev-environments";
import {
	KroPreviewEnvironmentProvisioner,
	SandboxExecutionPreviewEnvironmentProvisioner,
} from "$lib/server/application/adapters/preview";
import {
	OpenShellSandboxRuntimeInventory,
	WorkspaceRuntimeSandboxProvisioner,
} from "$lib/server/application/adapters/sandbox";
import { LocalRuntimeRegistryReader } from "$lib/server/application/adapters/runtime-registry";
import { KubernetesSessionRuntimeStatusReader } from "$lib/server/application/adapters/runtime-status";
import {
	CurrentSessionRepository,
	DaprSessionRuntimeEventRaiser,
	DefaultSessionRuntimeConfigReader,
	KubernetesSessionProvisioningReader,
	LegacyMlflowSessionTraceLifecycle,
	PostgresSessionEventLog,
	SessionAgentConfigCommandAdapter,
} from "$lib/server/application/adapters/sessions";
import { PlaywrightMcpBrowserRuntimeClient } from "$lib/server/application/adapters/browser-runtime";
import { getEventBusAdapter } from "$lib/server/application/event-bus";
import { ApplicationAgentRuntimeControlService } from "$lib/server/application/agent-runtime-control";
import { ApplicationSessionBrowserService } from "$lib/server/application/session-browser";
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
	let agentRuntimes: PostgresAgentRuntimeRepository | undefined;
	let workflowDefinitions: PostgresWorkflowDefinitionRepository | undefined;
	let workflowTriggers: PostgresWorkflowTriggerStore | undefined;
	let userProfiles: PostgresUserProfileRepository | undefined;
	let settings: PostgresSettingsRepository | undefined;
	let mcpConnections: PostgresMcpConnectionRepository | undefined;
	let hostedMcpServers: PostgresHostedMcpServerRepository | undefined;
	let mcpRuns: PostgresMcpRunRepository | undefined;
	let appConnections: PostgresAppConnectionRepository | undefined;
	let adminPieces: PostgresAdminPieceRepository | undefined;
	let apiKeys: PostgresApiKeyStore | undefined;
	let workspaceProjects: PostgresWorkspaceProjectRepository | undefined;
	let pieceCatalog: PostgresPieceCatalogRepository | undefined;
	let pieceExecutions: PostgresPieceExecutionRepository | undefined;
	let browserArtifacts: PostgresWorkflowBrowserArtifactStore | undefined;
	let codeFunctionCatalog: PostgresCodeFunctionCatalogRepository | undefined;
	let benchmarkArtifactMetadata:
		| PostgresBenchmarkArtifactMetadataRepository
		| undefined;
	let benchmarkEvaluationResults:
		| PostgresBenchmarkEvaluationResultRepository
		| undefined;
	let benchmarkBrowser: PostgresBenchmarkBrowserRepository | undefined;
	let benchmarkDatasetPromotions:
		| PostgresBenchmarkDatasetPromotionRepository
		| undefined;
	let benchmarkInstanceDetails:
		| PostgresBenchmarkInstanceDetailReadRepository
		| undefined;
	let benchmarkRunInstanceScores:
		| PostgresBenchmarkRunInstanceScoreReadRepository
		| undefined;
	let benchmarkRunInstanceDetails:
		| PostgresBenchmarkRunInstanceDetailReadRepository
		| undefined;
	let benchmarkRunInstanceAnnotations:
		| PostgresBenchmarkRunInstanceAnnotationRepository
		| undefined;
	let benchmarkRunInstanceProgress:
		| PostgresBenchmarkRunInstanceProgressReadRepository
		| undefined;
	let benchmarkRunReads: LegacyBenchmarkRunReadRepository | undefined;
	let devEnvironments: LegacyDevEnvironmentReadRepository | undefined;
	let benchmarkRuns: PostgresBenchmarkRunRepository | undefined;
	let activityRateTargets: PostgresWorkflowActivityRateTargetRepository | undefined;
	let observabilityTraces: PostgresObservabilityTraceRepository | undefined;
	let workflowMonitorReads: PostgresWorkflowMonitorReadRepository | undefined;
	let resourceUsages: PostgresResourceUsageReadRepository | undefined;
	let aiAssistantMessages: PostgresWorkflowAiAssistantMessageRepository | undefined;
	let securityAudit: PostgresSecurityAuditReadRepository | undefined;
	let dashboard: PostgresDashboardReadRepository | undefined;
	let homePageReads: PostgresHomePageReadRepository | undefined;
	let workflowExecutions: PostgresWorkflowExecutionRepository | undefined;
	let workflowFiles: PostgresWorkflowFileStore | undefined;
	let sandboxInventory: PostgresSandboxInventoryRepository | undefined;
	let artifactStore: PostgresArtifactStore | undefined;
	let workspaceSessions: PostgresWorkspaceSessionStore | undefined;
	let agentRuns: PostgresWorkflowAgentRunStore | undefined;
	let planArtifacts: PostgresWorkflowPlanArtifactStore | undefined;
	let traceLineage: PostgresTraceLineageStore | undefined;
	let usageReporting: PostgresUsageReportingRepository | undefined;
	let goalFlow: PostgresGoalFlowReadStore | undefined;
	let sessions: CurrentSessionRepository | undefined;
	let sessionProvisioning: KubernetesSessionProvisioningReader | undefined;
	let sessionEvents: PostgresSessionEventLog | undefined;
	let sessionRuntimeConfigs: DefaultSessionRuntimeConfigReader | undefined;
	let sessionRuntimeEvents: DaprSessionRuntimeEventRaiser | undefined;
	let sessionAgentConfigCommands: SessionAgentConfigCommandAdapter | undefined;
	let sessionTraceLifecycle: LegacyMlflowSessionTraceLifecycle | undefined;
	let peerAgentResolver: RegistryPeerAgentResolver | undefined;
	let sessionEventNotifications:
		| PostgresWorkflowSessionEventNotificationSource
		| undefined;
	let codeCheckpoints: PostgresWorkflowCodeCheckpointStore | undefined;
	let evaluationArtifacts: PostgresEvaluationArtifactStore | undefined;
	let workflowData: ApplicationWorkflowDataService | undefined;
	let agentRuntimeWarmPools: KubernetesAgentRuntimeWarmPoolClient | undefined;
	let agentRuntimeControl: ApplicationAgentRuntimeControlService | undefined;
	let sessionBrowser: ApplicationSessionBrowserService | undefined;
	const getDatabase = () => (database ??= requirePostgresDb());
	const getAgentRuntimes = () =>
		(agentRuntimes ??= new PostgresAgentRuntimeRepository(getDatabase()));
	const getWorkflowDefinitions = () =>
		(workflowDefinitions ??= new PostgresWorkflowDefinitionRepository(getDatabase()));
	const getWorkflowTriggers = () =>
		(workflowTriggers ??= new PostgresWorkflowTriggerStore(getDatabase()));
	const getUserProfiles = () =>
		(userProfiles ??= new PostgresUserProfileRepository(getDatabase()));
	const getSettings = () =>
		(settings ??= new PostgresSettingsRepository(getDatabase()));
	const getMcpConnections = () =>
		(mcpConnections ??= new PostgresMcpConnectionRepository(getDatabase()));
	const getHostedMcpServers = () =>
		(hostedMcpServers ??= new PostgresHostedMcpServerRepository(getDatabase()));
	const getMcpRuns = () => (mcpRuns ??= new PostgresMcpRunRepository(getDatabase()));
	const getAppConnections = () =>
		(appConnections ??= new PostgresAppConnectionRepository(getDatabase()));
	const getAdminPieces = () =>
		(adminPieces ??= new PostgresAdminPieceRepository(getDatabase()));
	const getApiKeys = () => (apiKeys ??= new PostgresApiKeyStore(getDatabase()));
	const getWorkspaceProjects = () =>
		(workspaceProjects ??= new PostgresWorkspaceProjectRepository(getDatabase()));
	const getPieceCatalog = () =>
		(pieceCatalog ??= new PostgresPieceCatalogRepository(getDatabase()));
	const getPieceExecutions = () =>
		(pieceExecutions ??= new PostgresPieceExecutionRepository(getDatabase()));
	const getBrowserArtifacts = () =>
		(browserArtifacts ??= new PostgresWorkflowBrowserArtifactStore(getDatabase()));
	const getCodeFunctionCatalog = () =>
		(codeFunctionCatalog ??= new PostgresCodeFunctionCatalogRepository(getDatabase()));
	const getBenchmarkArtifactMetadata = () =>
		(benchmarkArtifactMetadata ??= new PostgresBenchmarkArtifactMetadataRepository(getDatabase()));
	const getBenchmarkEvaluationResults = () =>
		(benchmarkEvaluationResults ??= new PostgresBenchmarkEvaluationResultRepository(getDatabase()));
	const getBenchmarkBrowser = () =>
		(benchmarkBrowser ??= new PostgresBenchmarkBrowserRepository(getDatabase()));
	const getBenchmarkDatasetPromotions = () =>
		(benchmarkDatasetPromotions ??= new PostgresBenchmarkDatasetPromotionRepository(getDatabase()));
	const getBenchmarkInstanceDetails = () =>
		(benchmarkInstanceDetails ??= new PostgresBenchmarkInstanceDetailReadRepository(getDatabase()));
	const getBenchmarkRunInstanceScores = () =>
		(benchmarkRunInstanceScores ??= new PostgresBenchmarkRunInstanceScoreReadRepository(getDatabase()));
	const getBenchmarkRunInstanceDetails = () =>
		(benchmarkRunInstanceDetails ??= new PostgresBenchmarkRunInstanceDetailReadRepository(getDatabase()));
	const getBenchmarkRunInstanceAnnotations = () =>
		(benchmarkRunInstanceAnnotations ??= new PostgresBenchmarkRunInstanceAnnotationRepository(getDatabase()));
	const getBenchmarkRunInstanceProgress = () =>
		(benchmarkRunInstanceProgress ??= new PostgresBenchmarkRunInstanceProgressReadRepository(getDatabase()));
	const getBenchmarkRunReads = () =>
		(benchmarkRunReads ??= new LegacyBenchmarkRunReadRepository());
	const getDevEnvironments = () =>
		(devEnvironments ??= new LegacyDevEnvironmentReadRepository());
	const getBenchmarkRuns = () =>
		(benchmarkRuns ??= new PostgresBenchmarkRunRepository(getDatabase()));
	const getActivityRateTargets = () =>
		(activityRateTargets ??= new PostgresWorkflowActivityRateTargetRepository(getDatabase()));
	const getObservabilityTraces = () =>
		(observabilityTraces ??= new PostgresObservabilityTraceRepository(getDatabase()));
	const getWorkflowMonitorReads = () =>
		(workflowMonitorReads ??= new PostgresWorkflowMonitorReadRepository(getDatabase()));
	const getResourceUsages = () =>
		(resourceUsages ??= new PostgresResourceUsageReadRepository(getDatabase()));
	const getAiAssistantMessages = () =>
		(aiAssistantMessages ??= new PostgresWorkflowAiAssistantMessageRepository(getDatabase()));
	const getSecurityAudit = () =>
		(securityAudit ??= new PostgresSecurityAuditReadRepository(getDatabase()));
	const getDashboard = () =>
		(dashboard ??= new PostgresDashboardReadRepository(getDatabase()));
	const getHomePageReads = () =>
		(homePageReads ??= new PostgresHomePageReadRepository(getDatabase()));
	const getWorkflowExecutions = () =>
		(workflowExecutions ??= new PostgresWorkflowExecutionRepository(getDatabase()));
	const getWorkflowFiles = () =>
		(workflowFiles ??= new PostgresWorkflowFileStore(getDatabase()));
	const getSandboxInventory = () =>
		(sandboxInventory ??= new PostgresSandboxInventoryRepository(getDatabase()));
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
	const getUsageReporting = () =>
		(usageReporting ??= new PostgresUsageReportingRepository(getDatabase()));
	const getGoalFlow = () =>
		(goalFlow ??= new PostgresGoalFlowReadStore(getDatabase()));
	const getSessions = () => (sessions ??= new CurrentSessionRepository(getDatabase()));
	const getSessionProvisioning = () =>
		(sessionProvisioning ??= new KubernetesSessionProvisioningReader());
	const getSessionEvents = () => (sessionEvents ??= new PostgresSessionEventLog());
	const getSessionRuntimeConfigs = () =>
		(sessionRuntimeConfigs ??= new DefaultSessionRuntimeConfigReader());
	const getSessionRuntimeEvents = () =>
		(sessionRuntimeEvents ??= new DaprSessionRuntimeEventRaiser());
	const getSessionAgentConfigCommands = () =>
		(sessionAgentConfigCommands ??= new SessionAgentConfigCommandAdapter());
	const getSessionTraceLifecycle = () =>
		(sessionTraceLifecycle ??= new LegacyMlflowSessionTraceLifecycle());
	const getPeerAgentResolver = () =>
		(peerAgentResolver ??= new RegistryPeerAgentResolver(getDatabase()));
	const getSessionEventNotifications = () =>
		(sessionEventNotifications ??= new PostgresWorkflowSessionEventNotificationSource());
	const getCodeCheckpoints = () =>
		(codeCheckpoints ??= new PostgresWorkflowCodeCheckpointStore(getDatabase()));
	const getEvaluationArtifacts = () =>
		(evaluationArtifacts ??= new PostgresEvaluationArtifactStore(getDatabase()));
	const getAgentRuntimeWarmPools = () =>
		(agentRuntimeWarmPools ??= new KubernetesAgentRuntimeWarmPoolClient());
	const getAgentRuntimeControl = () =>
		(agentRuntimeControl ??= new ApplicationAgentRuntimeControlService({
			agentRuntimes: getAgentRuntimes(),
			workspaceProjects: getWorkspaceProjects(),
			warmPools: getAgentRuntimeWarmPools(),
		}));
	const previewEnvironmentProvisioner =
		config.previewProvisionerAdapter === "kro"
			? new KroPreviewEnvironmentProvisioner()
			: new SandboxExecutionPreviewEnvironmentProvisioner();
	const workflowScheduler = new DaprWorkflowScheduler();
	const getWorkflowData = () =>
		(workflowData ??= new ApplicationWorkflowDataService({
			workflowDefinitions: getWorkflowDefinitions(),
			workflowTriggers: getWorkflowTriggers(),
			userProfiles: getUserProfiles(),
			settings: getSettings(),
			mcpConnections: getMcpConnections(),
			hostedMcpServers: getHostedMcpServers(),
			mcpRuns: getMcpRuns(),
			appConnections: getAppConnections(),
			adminPieces: getAdminPieces(),
			apiKeys: getApiKeys(),
			workspaceProjects: getWorkspaceProjects(),
			pieceCatalog: getPieceCatalog(),
			pieceExecutions: getPieceExecutions(),
			browserArtifacts: getBrowserArtifacts(),
			codeFunctionCatalog: getCodeFunctionCatalog(),
			benchmarkArtifactMetadata: getBenchmarkArtifactMetadata(),
			benchmarkEvaluationResults: getBenchmarkEvaluationResults(),
			benchmarkRunLifecycle: new LegacyBenchmarkRunLifecycleAdapter(),
			benchmarkEvaluationTelemetry: new LegacyBenchmarkEvaluationTelemetryAdapter(),
			benchmarkEvaluationEvents: new DaprBenchmarkEvaluationEventNotifier(),
			benchmarkBrowser: getBenchmarkBrowser(),
			benchmarkDatasetPromotions: getBenchmarkDatasetPromotions(),
			benchmarkInstanceDetails: getBenchmarkInstanceDetails(),
			benchmarkRunInstanceScores: getBenchmarkRunInstanceScores(),
			benchmarkRunInstanceDetails: getBenchmarkRunInstanceDetails(),
			benchmarkRunInstanceAnnotations: getBenchmarkRunInstanceAnnotations(),
			benchmarkRunInstanceProgress: getBenchmarkRunInstanceProgress(),
			benchmarkRunReads: getBenchmarkRunReads(),
			devEnvironments: getDevEnvironments(),
			benchmarkRuns: getBenchmarkRuns(),
			activityRateTargets: getActivityRateTargets(),
			observabilityTraces: getObservabilityTraces(),
			workflowMonitorReads: getWorkflowMonitorReads(),
			resourceUsages: getResourceUsages(),
			aiAssistantMessages: getAiAssistantMessages(),
			securityAudit: getSecurityAudit(),
			dashboard: getDashboard(),
			homePageReads: getHomePageReads(),
			workflowExecutions: getWorkflowExecutions(),
			sessions: getSessions(),
			sessionProvisioning: getSessionProvisioning(),
			sessionEvents: getSessionEvents(),
			sessionRuntimeConfigs: getSessionRuntimeConfigs(),
			sessionRuntimeEvents: getSessionRuntimeEvents(),
			sessionAgentConfigCommands: getSessionAgentConfigCommands(),
			sessionTraceLifecycle: getSessionTraceLifecycle(),
			peerAgentResolver: getPeerAgentResolver(),
			workflowAgentReads: getPeerAgentResolver(),
			runtimeRegistry: new LocalRuntimeRegistryReader(),
			sessionExperimentAgents: getPeerAgentResolver(),
			codeCheckpoints: getCodeCheckpoints(),
			evaluationArtifacts: getEvaluationArtifacts(),
			workflowFiles: getWorkflowFiles(),
			sandboxInventory: getSandboxInventory(),
			sandboxRuntimeInventory: new OpenShellSandboxRuntimeInventory(),
			sessionRuntimeStatus: new KubernetesSessionRuntimeStatusReader(),
			sessionEventNotifications: getSessionEventNotifications(),
			artifactStore: getArtifactStore(),
			workspaceSessions: getWorkspaceSessions(),
			agentRuns: getAgentRuns(),
			planArtifacts: getPlanArtifacts(),
			traceLineage: getTraceLineage(),
			usageReporting: getUsageReporting(),
			goalFlow: getGoalFlow(),
			workflowScheduler,
		}));
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
			return getWorkflowData();
		},
		get agentRuntimeControl() {
			return getAgentRuntimeControl();
		},
		get sessionBrowser() {
			return (sessionBrowser ??= new ApplicationSessionBrowserService({
				workflowData: getWorkflowData(),
				browserRuntime: new PlaywrightMcpBrowserRuntimeClient(),
			}));
		},
		workflowScheduler,
		eventBus: getEventBusAdapter(config),
		credentialStore: new DaprCredentialStore(),
		get sessions() {
			return getSessions();
		},
		get sessionEvents() {
			return getSessionEvents();
		},
		sandboxProvisioner: new WorkspaceRuntimeSandboxProvisioner(),
		previewEnvironmentProvisioner,
	};
}
