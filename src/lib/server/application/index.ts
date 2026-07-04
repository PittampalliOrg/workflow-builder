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
	PostgresModelCatalogRepository,
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
import {
	LegacySwebenchEnvironmentBuildProvisioner,
	PostgresSwebenchEnvironmentValidationRepository,
} from "$lib/server/application/adapters/benchmark-environment-validation";
import {
	LegacyAdminPieceRuntimeImageBuildPort,
	LegacyAdminPieceRuntimeImageRegistryPort,
} from "$lib/server/application/adapters/admin-piece-images";
import {
	PostgresUserCliCredentialStore,
	RawPostgresHostCliCredentialStore,
} from "$lib/server/application/adapters/cli-credentials";
import {
	LegacyAgentCompiledCapabilitiesRepository,
	AgentRuntimeRegistrySyncAdapter,
	LegacyAgentCatalogRepository,
	LegacyAgentRegistryRepository,
	LegacyWorkflowEphemeralAgentStore,
	LocalAgentRuntimeCatalog,
	LocalAgentTemplateCatalog,
	PostgresAgentSkillHydrationRepository,
	RegistryPeerAgentResolver,
} from "$lib/server/application/adapters/agents";
import { ClickHouseTraceOwnerResolver } from "$lib/server/application/adapters/observability-trace-access";
import { PostgresCapabilityBundleRepository } from "$lib/server/application/adapters/capability-bundles";
import { LegacyAgentSkillRepository } from "$lib/server/application/adapters/agent-skills";
import { PostgresResourceMetricsRepository } from "$lib/server/application/adapters/aggregate-metrics";
import { PostgresSessionResourceUsageRepository } from "$lib/server/application/adapters/session-resource-usage";
import { PostgresSandboxActiveSessionGuard } from "$lib/server/application/adapters/sandbox-active-guard";
import { LegacyAgentImportExportReferenceRepository } from "$lib/server/application/adapters/agent-import-export";
import {
	DaprCredentialStore,
	DaprEventBus,
	DaprLegacyAgentPlanReader,
	DaprWorkflowApprovalEventPort,
	DaprWorkflowScheduler,
} from "$lib/server/application/adapters/dapr";
import { DaprClientInspectionRuntimeAdapter } from "$lib/server/application/adapters/dapr-inspection";
import { SessionFleetActivityAdapter } from "$lib/server/application/adapters/capacity-active";
import {
	ClickHouseCapacityMetricsAdapter,
	HttpCapacityObserverAdapter,
	LegacyCapacityBusinessWorkAdapter,
	LegacyCapacityOwnershipAdapter,
	OtelCapacityRemoteTelemetryAdapter,
} from "$lib/server/application/adapters/capacity-overview";
import { LegacyBenchmarkRunDetailReadAdapter } from "$lib/server/application/adapters/benchmark-run-detail";
import { LegacyBenchmarkRunReadRepository } from "$lib/server/application/adapters/benchmark-runs";
import { PostgresDevEnvironmentReadRepository } from "$lib/server/application/adapters/dev-environments";
import {
	DaprLifecycleCoordinatorCancelNotifier,
	ServiceBenchmarkRunCancellationPort,
	ServiceEvaluationRunCancellationPort,
} from "$lib/server/application/adapters/lifecycle-bulk-stop";
import { DaprCoordinatorCancelAdapter } from "$lib/server/application/adapters/run-cancellation";
import {
	LegacyBenchmarkRunLaunchAdapter,
	LegacyEvaluationRunLaunchAdapter,
} from "$lib/server/application/adapters/run-launch";
import {
	LegacyEvaluationDatasetImportParser,
	LegacyEvaluationDatasetRepository,
	LegacyEvaluationTemplateRepository,
	StaticSwebenchSuiteCatalog,
} from "$lib/server/application/adapters/evaluations";
import { LegacyEnvironmentRepository } from "$lib/server/application/adapters/environments";
import { PostgresEnvironmentMaintenanceRepository } from "$lib/server/application/adapters/environment-maintenance";
import { LegacyVaultRepository } from "$lib/server/application/adapters/vaults";
import { PostgresVaultCredentialRepository } from "$lib/server/application/adapters/vault-credentials";
import { LegacyBenchmarkCapacityDiagnosticsAdapter } from "$lib/server/application/adapters/benchmark-capacity-diagnostics";
import { LegacyBenchmarkInstanceLifecycleAdapter } from "$lib/server/application/adapters/benchmark-instance-lifecycle";
import { EnvBenchmarkRunInstanceMlflowLinks } from "$lib/server/application/adapters/benchmark-run-instance-detail";
import { LegacyEvaluationRunDetailReadAdapter } from "$lib/server/application/adapters/evaluation-run-detail";
import {
	KroPreviewEnvironmentProvisioner,
	SandboxExecutionPreviewEnvironmentProvisioner,
} from "$lib/server/application/adapters/preview";
import { PostgresPreviewDatabaseProvisioner } from "$lib/server/application/adapters/preview-database";
import {
	OpenShellSandboxRuntimeInventory,
	WorkspaceRuntimeSandboxProvisioner,
} from "$lib/server/application/adapters/sandbox";
import { PostgresSandboxAgentEventReadPort } from "$lib/server/application/adapters/sandbox-events";
import { LocalRuntimeRegistryReader } from "$lib/server/application/adapters/runtime-registry";
import {
	LocalRuntimeCatalogReader,
	LocalWorkflowTriggerKindCatalogReader,
} from "$lib/server/application/adapters/catalogs";
import {
	DaprPieceOptionsClient,
	LocalActionOptionsCatalogReader,
	LocalCodeFunctionOptionsPort,
	WorkflowDataActionOptionsConnectionReader,
} from "$lib/server/application/adapters/action-options";
import {
	DaprActionCatalogHttpTestClient,
	LocalActionCatalogTestReader,
} from "$lib/server/application/adapters/action-catalog-test";
import {
	DaprCodeFunctionOptionsRuntimeClient,
	PostgresCodeFunctionOptionsRepository,
} from "$lib/server/application/adapters/code-function-options";
import {
	LocalCodeFunctionParsePreviewPort,
	PostgresCodeFunctionManagementRepository,
	PostgresCodeFunctionStore,
} from "$lib/server/application/adapters/code-functions";
import { PostgresCatalogFunctionDefinitionReader } from "$lib/server/application/adapters/catalog-function-definition";
import {
	DaprFunctionRouterExecutionPort,
	PostgresCodeFunctionExecutionRepository,
} from "$lib/server/application/adapters/code-function-execution";
import { LegacyActionCatalogReader } from "$lib/server/application/adapters/action-catalog";
import { LocalSettingsCliRuntimeCatalogReader } from "$lib/server/application/adapters/settings-cli-tokens";
import {
	PostgresPromptPresetRepository,
	PostgresPromptStackPresetReadRepository,
} from "$lib/server/application/adapters/prompt-presets";
import { KubernetesSessionRuntimeStatusReader } from "$lib/server/application/adapters/runtime-status";
import {
	CurrentSessionRepository,
	DaprSessionGoalLoopDriver,
	DaprSessionWorkflowSpawner,
	DaprSessionRuntimeEventRaiser,
	DaprSessionUserEventCommandAdapter,
	DefaultSessionRuntimeConfigReader,
	KubernetesSessionSandboxDestroyer,
	KubernetesSessionProvisioningReader,
	LifecycleSessionController,
	LifecycleSessionGoalScopeGuard,
	LegacyMlflowSessionTraceLifecycle,
	PostgresSessionGoalStore,
	RuntimeSessionGoalHarnessResolver,
	SessionAgentConfigCommandAdapter,
	WorkspaceSessionRepositoryMounter,
} from "$lib/server/application/adapters/sessions";
import { PostgresSessionEventLog } from "$lib/server/application/adapters/session-events";
import { PostgresGoalLoopStore } from "$lib/server/application/adapters/goal-loop-store";
import { PlaywrightMcpBrowserRuntimeClient } from "$lib/server/application/adapters/browser-runtime";
import {
	RegistrySessionMcpAgentConfigReader,
	VaultSessionMcpCredentialStatusReader,
} from "$lib/server/application/adapters/session-mcp";
import {
	LegacyWorkflowRunStarterPort,
	LegacyWorkflowSpecValidatorPort,
	LifecycleWorkflowExecutionControllerPort,
	LifecycleWorkflowExecutionCoordinatorOwnerPort,
} from "$lib/server/application/adapters/workflow-control";
import { DaprWorkflowRuntimeStatusPort } from "$lib/server/application/adapters/workflow-runtime-status";
import { PostgresLifecycleCoordinatorOwnerStore } from "$lib/server/application/adapters/lifecycle-ownership";
import {
	LegacyTriggeredRunAdmissionPort,
	ShaTriggeredWorkflowExecutionIdPort,
} from "$lib/server/application/adapters/triggered-workflow-start";
import {
	LegacyCompletedWorkflowGoalFinalizer,
	LegacyGoalCompletionEvaluator,
} from "$lib/server/application/adapters/internal-goal-control";
import { PostgresWorkflowConnectionRefSyncPort } from "$lib/server/application/adapters/workflow-connections";
import { PostgresAgentProfileReadRepository } from "$lib/server/application/adapters/agent-profiles";
import { LegacyWorkflowCodeCheckpointWorkspacePort } from "$lib/server/application/adapters/workflow-code-checkpoints";
import {
	LegacyWorkflowEmitterAdapter,
	PostgresWorkflowCodeFunctionAdapter,
} from "$lib/server/application/adapters/workflow-export";
import {
	HelperPodSourceBundlePromotionRunner,
	WorkflowPromotionGateAdapter,
} from "$lib/server/application/adapters/workflow-code-version-promotion";
import { PostgresGitOpsActivityEventStore } from "$lib/server/application/adapters/gitops-activity-events";
import { JuiceFsWorkflowExecutionWorkspaceAdapter } from "$lib/server/application/adapters/workflow-execution-workspace";
import { LegacyCliPreviewGatewayPort } from "$lib/server/application/adapters/cli-preview";
import { LegacySandboxPreviewGatewayPort } from "$lib/server/application/adapters/sandbox-preview";
import { WorkflowTriggerLifecycleAdapter } from "$lib/server/application/adapters/workflow-trigger-lifecycle";
import { getEventBusAdapter } from "$lib/server/application/event-bus";
import { ApplicationAgentRuntimeControlService } from "$lib/server/application/agent-runtime-control";
import { ApplicationAgentCatalogService } from "$lib/server/application/agent-catalog";
import { ApplicationAgentImportExportService } from "$lib/server/application/agent-import-export";
import { ApplicationAgentProfileService } from "$lib/server/application/agent-profiles";
import { ApplicationAgentRegistryBrowserService } from "$lib/server/application/agent-registry-browser";
import { DaprAgentRegistryStateReaderAdapter } from "$lib/server/application/adapters/agent-registry-browser";
import { ApplicationObservabilityTraceAccessService } from "$lib/server/application/observability-trace-access";
import { ApplicationCapabilityBundleService } from "$lib/server/application/capability-bundles";
import { ApplicationAgentSkillService } from "$lib/server/application/agent-skills";
import { ApplicationResourceMetricsService } from "$lib/server/application/resource-metrics";
import { ApplicationSandboxActiveGuardService } from "$lib/server/application/sandbox-active-guard";
import { ApplicationCliPreviewService } from "$lib/server/application/cli-preview";
import { ApplicationSandboxPreviewService } from "$lib/server/application/sandbox-preview";
import { ApplicationSessionCommandService } from "$lib/server/application/session-commands";
import { ApplicationSessionAgentConfigService } from "$lib/server/application/session-agent-config";
import { ApplicationSessionGoalService } from "$lib/server/application/session-goals";
import {
	ApplicationInternalGoalControlService,
	DateGoalRejectionSourceEventIdPort,
} from "$lib/server/application/internal-goal-control";
import { ApplicationSessionLifecycleService } from "$lib/server/application/session-lifecycle";
import { ApplicationSessionSandboxService } from "$lib/server/application/session-sandboxes";
import { ApplicationSandboxEventsService } from "$lib/server/application/sandbox-events";
import { ApplicationSessionMcpStatusService } from "$lib/server/application/session-mcp-status";
import { ApplicationSessionRuntimeAccessService } from "$lib/server/application/session-runtime-access";
import { ApplicationSessionBrowserService } from "$lib/server/application/session-browser";
import { ApplicationPeerSessionSpawnService } from "$lib/server/application/peer-session-spawn";
import { ApplicationBulkLifecycleStopService } from "$lib/server/application/lifecycle-bulk-stop";
import { ApplicationBenchmarkRunDetailPageService } from "$lib/server/application/benchmark-run-detail";
import { ApplicationBenchmarkCompareService } from "$lib/server/application/benchmark-compare";
import { ApplicationCapacityActiveService } from "$lib/server/application/capacity-active";
import { ApplicationCapacityOverviewService } from "$lib/server/application/capacity-overview";
import { ApplicationDaprInspectionService } from "$lib/server/application/dapr-inspection";
import {
	ApplicationRuntimeCatalogService,
	ApplicationWorkflowTriggerKindCatalogService,
} from "$lib/server/application/catalogs";
import { ApplicationCatalogFunctionDefinitionService } from "$lib/server/application/catalog-function-definition";
import { ApplicationActionOptionsService } from "$lib/server/application/action-options";
import { ApplicationActionCatalogService } from "$lib/server/application/action-catalog";
import {
	ApplicationActionCatalogTestService,
	DateActionCatalogTestExecutionIdGenerator,
} from "$lib/server/application/action-catalog-test";
import { ApplicationCodeFunctionOptionsService } from "$lib/server/application/code-function-options";
import { ApplicationCodeFunctionManagementService } from "$lib/server/application/code-function-management";
import { ApplicationCodeFunctionParsePreviewService } from "$lib/server/application/code-function-parse-preview";
import {
	ApplicationCodeFunctionExecutionService,
	DateCodeFunctionExecutionIdGenerator,
} from "$lib/server/application/code-function-execution";
import { ApplicationCliCredentialsService } from "$lib/server/application/cli-credentials";
import { ApplicationSettingsCliTokensService } from "$lib/server/application/settings-cli-tokens";
import {
	ApplicationPromptPresetService,
	ApplicationPromptStackCompilerService,
} from "$lib/server/application/prompt-presets";
import {
	ApplicationBenchmarkRunLaunchService,
	ApplicationEvaluationRunLaunchService,
} from "$lib/server/application/run-launch";
import { ApplicationEvaluationDatasetService } from "$lib/server/application/evaluation-datasets";
import { ApplicationEvaluationTemplateService } from "$lib/server/application/evaluation-templates";
import { ApplicationEnvironmentService } from "$lib/server/application/environment-management";
import { ApplicationVaultService } from "$lib/server/application/vault-management";
import { ApplicationVaultCredentialService } from "$lib/server/application/vault-credentials";
import { ApplicationBenchmarkCapacityDiagnosticsService } from "$lib/server/application/benchmark-capacity-diagnostics";
import { ApplicationBenchmarkEnvironmentValidationService } from "$lib/server/application/benchmark-environment-validation";
import { ApplicationBenchmarkInstanceLifecycleService } from "$lib/server/application/benchmark-instance-lifecycle";
import { ApplicationBenchmarkRunInstanceDetailService } from "$lib/server/application/benchmark-run-instance-detail";
import { ApplicationRunCancellationService } from "$lib/server/application/run-cancellation";
import { ApplicationEvaluationRunDetailService } from "$lib/server/application/evaluation-run-detail";
import { ApplicationWorkflowDefinitionCommandService } from "$lib/server/application/workflow-definition-commands";
import { ApplicationWorkflowExportService } from "$lib/server/application/workflow-export";
import { ApplicationWorkflowBrowserArtifactsService } from "$lib/server/application/workflow-browser-artifacts";
import { ApplicationWorkflowExecutionArtifactDiffService } from "$lib/server/application/workflow-execution-artifact-diff";
import { ApplicationWorkflowExecutionArtifactsService } from "$lib/server/application/workflow-execution-artifacts";
import { ApplicationWorkflowExecutionControlService } from "$lib/server/application/workflow-execution-control";
import { ApplicationTriggeredWorkflowStartService } from "$lib/server/application/triggered-workflow-start";
import { ApplicationWorkflowExecutionFilesService } from "$lib/server/application/workflow-execution-files";
import { ApplicationWorkflowExecutionLineageService } from "$lib/server/application/workflow-execution-lineage";
import { ApplicationWorkflowExecutionLogsService } from "$lib/server/application/workflow-execution-logs";
import { ApplicationWorkflowExecutionMetricsService } from "$lib/server/application/workflow-execution-metrics";
import { ApplicationWorkflowExecutionSessionsService } from "$lib/server/application/workflow-execution-sessions";
import { ApplicationWorkflowExecutionSpecDiffService } from "$lib/server/application/workflow-execution-spec-diff";
import { ApplicationWorkflowExecutionWorkspaceService } from "$lib/server/application/workflow-execution-workspace";
import { ApplicationWorkflowExecutionStreamService } from "$lib/server/application/workflow-execution-stream";
import { ApplicationWorkflowExecutionReadModelService } from "$lib/server/application/workflow-execution-read-model";
import { ApplicationWorkflowCodeCheckpointService } from "$lib/server/application/workflow-code-checkpoints";
import { ApplicationWorkflowCodeVersionService } from "$lib/server/application/workflow-code-versions";
import { ApplicationWorkflowCodeVersionPromotionService } from "$lib/server/application/workflow-code-version-promotion";
import { ApplicationWorkflowTriggerManagementService } from "$lib/server/application/workflow-trigger-management";
import { ApplicationWorkflowTriggerLifecycleService } from "$lib/server/application/workflow-trigger-lifecycle";
import { ApplicationWorkflowDataService } from "$lib/server/application/workflow-data";
import { ApplicationWorkflowPlanService } from "$lib/server/application/workflow-plan";
import { ApplicationGitOpsActivityEventService } from "$lib/server/application/gitops-activity-events";
import { extractExecutionTraceIds } from "$lib/server/otel/clickhouse";
import { costFor, formatCurrency } from "$lib/server/pricing/model-pricing";
import {
	resolveRunDiffPatch,
	RUN_DIFF_KIND,
} from "$lib/server/workflows/run-diff";

export { getEventBusAdapter } from "$lib/server/application/event-bus";

export function getApplicationAdapters(
	config: ApplicationAdapterConfig = getApplicationAdapterConfig(),
) {
	if (config.persistenceAdapter !== "postgres") {
		throw new Error(
			`Unsupported persistence adapter: ${config.persistenceAdapter}`,
		);
	}
	if (config.artifactStoreAdapter !== "postgres-metadata-object-data") {
		throw new Error(
			`Unsupported artifact store adapter: ${config.artifactStoreAdapter}`,
		);
	}
	if (config.workflowSchedulerAdapter !== "dapr-workflow") {
		throw new Error(
			`Unsupported workflow scheduler adapter: ${config.workflowSchedulerAdapter}`,
		);
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
	let devEnvironments: PostgresDevEnvironmentReadRepository | undefined;
	let benchmarkRuns: PostgresBenchmarkRunRepository | undefined;
	let activityRateTargets:
		| PostgresWorkflowActivityRateTargetRepository
		| undefined;
	let observabilityTraces: PostgresObservabilityTraceRepository | undefined;
	let observabilityTraceAccess:
		| ApplicationObservabilityTraceAccessService
		| undefined;
	let capabilityBundles: ApplicationCapabilityBundleService | undefined;
	let agentSkills: ApplicationAgentSkillService | undefined;
	let resourceMetrics: ApplicationResourceMetricsService | undefined;
	let sandboxActiveGuard: ApplicationSandboxActiveGuardService | undefined;
	let workflowMonitorReads: PostgresWorkflowMonitorReadRepository | undefined;
	let resourceUsages: PostgresResourceUsageReadRepository | undefined;
	let aiAssistantMessages:
		| PostgresWorkflowAiAssistantMessageRepository
		| undefined;
	let securityAudit: PostgresSecurityAuditReadRepository | undefined;
	let dashboard: PostgresDashboardReadRepository | undefined;
	let homePageReads: PostgresHomePageReadRepository | undefined;
	let modelCatalog: PostgresModelCatalogRepository | undefined;
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
	let sessionGoalStore: PostgresSessionGoalStore | undefined;
	let peerAgentResolver: RegistryPeerAgentResolver | undefined;
	let agentSkillHydration:
		| PostgresAgentSkillHydrationRepository
		| undefined;
	let sessionEventNotifications:
		| PostgresWorkflowSessionEventNotificationSource
		| undefined;
	let codeCheckpoints: PostgresWorkflowCodeCheckpointStore | undefined;
	let evaluationArtifacts: PostgresEvaluationArtifactStore | undefined;
	let workflowData: ApplicationWorkflowDataService | undefined;
	let agentRuntimeWarmPools: KubernetesAgentRuntimeWarmPoolClient | undefined;
	let agentRuntimeControl: ApplicationAgentRuntimeControlService | undefined;
	let agentCatalog: ApplicationAgentCatalogService | undefined;
	let agentImportExport: ApplicationAgentImportExportService | undefined;
	let agentProfiles: ApplicationAgentProfileService | undefined;
	let agentRegistryBrowser: ApplicationAgentRegistryBrowserService | undefined;
	let sandboxProvisioner: WorkspaceRuntimeSandboxProvisioner | undefined;
	let repositoryMounter: WorkspaceSessionRepositoryMounter | undefined;
	let workflowSpawner: DaprSessionWorkflowSpawner | undefined;
	let sessionCommands: ApplicationSessionCommandService | undefined;
	let sessionAgentConfig: ApplicationSessionAgentConfigService | undefined;
	let sessionGoals: ApplicationSessionGoalService | undefined;
	let internalGoalControl: ApplicationInternalGoalControlService | undefined;
	let sessionLifecycle: ApplicationSessionLifecycleService | undefined;
	let sessionSandboxes: ApplicationSessionSandboxService | undefined;
	let sessionMcpStatus: ApplicationSessionMcpStatusService | undefined;
	let sessionRuntimeAccess: ApplicationSessionRuntimeAccessService | undefined;
	let sessionBrowser: ApplicationSessionBrowserService | undefined;
	let peerSessionSpawn: ApplicationPeerSessionSpawnService | undefined;
	let bulkLifecycleStop: ApplicationBulkLifecycleStopService | undefined;
	let runCancellation: ApplicationRunCancellationService | undefined;
	let benchmarkRunLaunch: ApplicationBenchmarkRunLaunchService | undefined;
	let evaluationRunLaunch: ApplicationEvaluationRunLaunchService | undefined;
	let evaluationDatasets: ApplicationEvaluationDatasetService | undefined;
	let evaluationTemplates: ApplicationEvaluationTemplateService | undefined;
	let environments: ApplicationEnvironmentService | undefined;
	let vaultsService: ApplicationVaultService | undefined;
	let vaultCredentialRepository: PostgresVaultCredentialRepository | undefined;
	let vaultCredentialsService: ApplicationVaultCredentialService | undefined;
	let benchmarkCapacityDiagnostics:
		| ApplicationBenchmarkCapacityDiagnosticsService
		| undefined;
	let benchmarkEnvironmentValidation:
		| ApplicationBenchmarkEnvironmentValidationService
		| undefined;
	let benchmarkInstanceLifecycle:
		| ApplicationBenchmarkInstanceLifecycleService
		| undefined;
	let evaluationRunDetail: ApplicationEvaluationRunDetailService | undefined;
	let benchmarkRunDetail: ApplicationBenchmarkRunDetailPageService | undefined;
	let benchmarkRunInstanceDetail:
		| ApplicationBenchmarkRunInstanceDetailService
		| undefined;
	let benchmarkCompare: ApplicationBenchmarkCompareService | undefined;
	let capacityActive: ApplicationCapacityActiveService | undefined;
	let capacityOverview: ApplicationCapacityOverviewService | undefined;
	let daprInspection: ApplicationDaprInspectionService | undefined;
	let runtimeCatalog: ApplicationRuntimeCatalogService | undefined;
	let catalogFunctionDefinition:
		| ApplicationCatalogFunctionDefinitionService
		| undefined;
	let actionCatalog: ApplicationActionCatalogService | undefined;
	let workflowTriggerKindCatalog:
		| ApplicationWorkflowTriggerKindCatalogService
		| undefined;
	let actionOptions: ApplicationActionOptionsService | undefined;
	let actionCatalogTest: ApplicationActionCatalogTestService | undefined;
	let codeFunctionManagement:
		| ApplicationCodeFunctionManagementService
		| undefined;
	let codeFunctionParsePreview:
		| ApplicationCodeFunctionParsePreviewService
		| undefined;
	let codeFunctionOptions: ApplicationCodeFunctionOptionsService | undefined;
	let codeFunctionExecution:
		| ApplicationCodeFunctionExecutionService
		| undefined;
	let codeFunctionStore: PostgresCodeFunctionStore | undefined;
	let cliCredentials: ApplicationCliCredentialsService | undefined;
	let settingsCliTokens: ApplicationSettingsCliTokensService | undefined;
	let promptPresets: ApplicationPromptPresetService | undefined;
	let promptStackCompiler: ApplicationPromptStackCompilerService | undefined;
	let workflowDefinitionCommands:
		| ApplicationWorkflowDefinitionCommandService
		| undefined;
	let workflowExport: ApplicationWorkflowExportService | undefined;
	let workflowExecutionControl:
		| ApplicationWorkflowExecutionControlService
		| undefined;
	let triggeredWorkflowStart:
		| ApplicationTriggeredWorkflowStartService
		| undefined;
	let workflowExecutionArtifactDiff:
		| ApplicationWorkflowExecutionArtifactDiffService
		| undefined;
	let workflowExecutionArtifacts:
		| ApplicationWorkflowExecutionArtifactsService
		| undefined;
	let workflowExecutionFiles:
		| ApplicationWorkflowExecutionFilesService
		| undefined;
	let workflowExecutionLineage:
		| ApplicationWorkflowExecutionLineageService
		| undefined;
	let workflowExecutionLogs:
		| ApplicationWorkflowExecutionLogsService
		| undefined;
	let workflowExecutionMetrics:
		| ApplicationWorkflowExecutionMetricsService
		| undefined;
	let workflowExecutionSessions:
		| ApplicationWorkflowExecutionSessionsService
		| undefined;
	let workflowExecutionSpecDiff:
		| ApplicationWorkflowExecutionSpecDiffService
		| undefined;
	let workflowExecutionWorkspace:
		| ApplicationWorkflowExecutionWorkspaceService
		| undefined;
	let workflowExecutionStream:
		| ApplicationWorkflowExecutionStreamService
		| undefined;
	let workflowExecutionReadModels:
		| ApplicationWorkflowExecutionReadModelService
		| undefined;
	let workflowBrowserArtifacts:
		| ApplicationWorkflowBrowserArtifactsService
		| undefined;
	let workflowCodeCheckpoints:
		| ApplicationWorkflowCodeCheckpointService
		| undefined;
	let workflowCodeVersions: ApplicationWorkflowCodeVersionService | undefined;
	let workflowCodeVersionPromotion:
		| ApplicationWorkflowCodeVersionPromotionService
		| undefined;
	let workflowTriggerLifecycle:
		| ApplicationWorkflowTriggerLifecycleService
		| undefined;
	let workflowTriggerManagement:
		| ApplicationWorkflowTriggerManagementService
		| undefined;
	let workflowPlan: ApplicationWorkflowPlanService | undefined;
	let gitOpsActivityEvents: ApplicationGitOpsActivityEventService | undefined;
	let cliPreview: ApplicationCliPreviewService | undefined;
	let sandboxPreview: ApplicationSandboxPreviewService | undefined;
	let sandboxEvents: ApplicationSandboxEventsService | undefined;
	let previewEnvironmentProvisioner:
		| KroPreviewEnvironmentProvisioner
		| SandboxExecutionPreviewEnvironmentProvisioner
		| undefined;
	const getDatabase = () => (database ??= requirePostgresDb());
	const getAgentRuntimes = () =>
		(agentRuntimes ??= new PostgresAgentRuntimeRepository(getDatabase()));
	const getWorkflowDefinitions = () =>
		(workflowDefinitions ??= new PostgresWorkflowDefinitionRepository(
			getDatabase(),
		));
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
	const getMcpRuns = () =>
		(mcpRuns ??= new PostgresMcpRunRepository(getDatabase()));
	const getAppConnections = () =>
		(appConnections ??= new PostgresAppConnectionRepository(getDatabase()));
	const getAdminPieces = () =>
		(adminPieces ??= new PostgresAdminPieceRepository(getDatabase()));
	const getApiKeys = () => (apiKeys ??= new PostgresApiKeyStore(getDatabase()));
	const getWorkspaceProjects = () =>
		(workspaceProjects ??= new PostgresWorkspaceProjectRepository(
			getDatabase(),
		));
	const getPieceCatalog = () =>
		(pieceCatalog ??= new PostgresPieceCatalogRepository(getDatabase()));
	const getPieceExecutions = () =>
		(pieceExecutions ??= new PostgresPieceExecutionRepository(getDatabase()));
	const getBrowserArtifacts = () =>
		(browserArtifacts ??= new PostgresWorkflowBrowserArtifactStore(
			getDatabase(),
		));
	const getCodeFunctionCatalog = () =>
		(codeFunctionCatalog ??= new PostgresCodeFunctionCatalogRepository(
			getDatabase(),
		));
	const getBenchmarkArtifactMetadata = () =>
		(benchmarkArtifactMetadata ??=
			new PostgresBenchmarkArtifactMetadataRepository(getDatabase()));
	const getBenchmarkEvaluationResults = () =>
		(benchmarkEvaluationResults ??=
			new PostgresBenchmarkEvaluationResultRepository(getDatabase()));
	const getBenchmarkBrowser = () =>
		(benchmarkBrowser ??= new PostgresBenchmarkBrowserRepository(
			getDatabase(),
		));
	const getBenchmarkDatasetPromotions = () =>
		(benchmarkDatasetPromotions ??=
			new PostgresBenchmarkDatasetPromotionRepository(getDatabase()));
	const getBenchmarkInstanceDetails = () =>
		(benchmarkInstanceDetails ??=
			new PostgresBenchmarkInstanceDetailReadRepository(getDatabase()));
	const getBenchmarkRunInstanceScores = () =>
		(benchmarkRunInstanceScores ??=
			new PostgresBenchmarkRunInstanceScoreReadRepository(getDatabase()));
	const getBenchmarkRunInstanceDetails = () =>
		(benchmarkRunInstanceDetails ??=
			new PostgresBenchmarkRunInstanceDetailReadRepository(getDatabase()));
	const getBenchmarkRunInstanceAnnotations = () =>
		(benchmarkRunInstanceAnnotations ??=
			new PostgresBenchmarkRunInstanceAnnotationRepository(getDatabase()));
	const getBenchmarkRunInstanceProgress = () =>
		(benchmarkRunInstanceProgress ??=
			new PostgresBenchmarkRunInstanceProgressReadRepository(getDatabase()));
	const getBenchmarkRunReads = () =>
		(benchmarkRunReads ??= new LegacyBenchmarkRunReadRepository());
	const getDevEnvironments = () =>
		(devEnvironments ??= new PostgresDevEnvironmentReadRepository(getDatabase()));
	const getBenchmarkRuns = () =>
		(benchmarkRuns ??= new PostgresBenchmarkRunRepository(getDatabase()));
	const getActivityRateTargets = () =>
		(activityRateTargets ??= new PostgresWorkflowActivityRateTargetRepository(
			getDatabase(),
		));
	const getObservabilityTraces = () =>
		(observabilityTraces ??= new PostgresObservabilityTraceRepository(
			getDatabase(),
		));
	const getObservabilityTraceAccess = () =>
		(observabilityTraceAccess ??= new ApplicationObservabilityTraceAccessService({
			owners: new ClickHouseTraceOwnerResolver(),
			access: getObservabilityTraces(),
		}));
	const getCapabilityBundles = () =>
		(capabilityBundles ??= new ApplicationCapabilityBundleService(
			new PostgresCapabilityBundleRepository(getDatabase()),
		));
	const getAgentSkills = () =>
		(agentSkills ??= new ApplicationAgentSkillService(
			new LegacyAgentSkillRepository(),
		));
	const getResourceMetrics = () =>
		(resourceMetrics ??= new ApplicationResourceMetricsService({
			getAggregateMetrics: new PostgresResourceMetricsRepository()
				.getAggregateMetrics,
			computeRightsizingRecommendations:
				new PostgresSessionResourceUsageRepository()
					.computeRightsizingRecommendations,
			sampleAndPersistSessionResourceUsage:
				new PostgresSessionResourceUsageRepository()
					.sampleAndPersistSessionResourceUsage,
		}));
	const getSandboxActiveGuard = () =>
		(sandboxActiveGuard ??= new ApplicationSandboxActiveGuardService(
			new PostgresSandboxActiveSessionGuard(),
		));
	const getWorkflowMonitorReads = () =>
		(workflowMonitorReads ??= new PostgresWorkflowMonitorReadRepository(
			getDatabase(),
		));
	const getResourceUsages = () =>
		(resourceUsages ??= new PostgresResourceUsageReadRepository(getDatabase()));
	const getAiAssistantMessages = () =>
		(aiAssistantMessages ??= new PostgresWorkflowAiAssistantMessageRepository(
			getDatabase(),
		));
	const getSecurityAudit = () =>
		(securityAudit ??= new PostgresSecurityAuditReadRepository(getDatabase()));
	const getDashboard = () =>
		(dashboard ??= new PostgresDashboardReadRepository(getDatabase()));
	const getHomePageReads = () =>
		(homePageReads ??= new PostgresHomePageReadRepository(getDatabase()));
	const getModelCatalog = () =>
		(modelCatalog ??= new PostgresModelCatalogRepository(getDatabase()));
	const getWorkflowExecutions = () =>
		(workflowExecutions ??= new PostgresWorkflowExecutionRepository(
			getDatabase(),
		));
	const getWorkflowFiles = () =>
		(workflowFiles ??= new PostgresWorkflowFileStore(getDatabase()));
	const getSandboxInventory = () =>
		(sandboxInventory ??= new PostgresSandboxInventoryRepository(
			getDatabase(),
		));
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
	const getSessions = () =>
		(sessions ??= new CurrentSessionRepository(getDatabase()));
	const getSessionProvisioning = () =>
		(sessionProvisioning ??= new KubernetesSessionProvisioningReader());
	const getSessionEvents = () =>
		(sessionEvents ??= new PostgresSessionEventLog(getDatabase()));
	const getSessionRuntimeConfigs = () =>
		(sessionRuntimeConfigs ??= new DefaultSessionRuntimeConfigReader(
			getDatabase(),
		));
	const getSessionRuntimeEvents = () =>
		(sessionRuntimeEvents ??= new DaprSessionRuntimeEventRaiser());
	const getSessionAgentConfigCommands = () =>
		(sessionAgentConfigCommands ??= new SessionAgentConfigCommandAdapter());
	const getSessionTraceLifecycle = () =>
		(sessionTraceLifecycle ??= new LegacyMlflowSessionTraceLifecycle());
	const getSessionGoalStore = () =>
		(sessionGoalStore ??= new PostgresSessionGoalStore(getDatabase()));
	const getGoalLoopStore = () => new PostgresGoalLoopStore(getDatabase);
	const getPeerAgentResolver = () =>
		(peerAgentResolver ??= new RegistryPeerAgentResolver(getDatabase()));
	const getAgentSkillHydration = () =>
		(agentSkillHydration ??= new PostgresAgentSkillHydrationRepository(
			getDatabase(),
		));
	const getSessionEventNotifications = () =>
		(sessionEventNotifications ??=
			new PostgresWorkflowSessionEventNotificationSource());
	const getSandboxProvisioner = () =>
		(sandboxProvisioner ??= new WorkspaceRuntimeSandboxProvisioner());
	const getRepositoryMounter = () =>
		(repositoryMounter ??= new WorkspaceSessionRepositoryMounter());
	const getWorkflowSpawner = () =>
		(workflowSpawner ??= new DaprSessionWorkflowSpawner());
	const getSessionGoals = () =>
		(sessionGoals ??= new ApplicationSessionGoalService({
			sessions: getSessions(),
			goals: getSessionGoalStore(),
			goalLoop: new DaprSessionGoalLoopDriver(getGoalLoopStore()),
			goalHarness: new RuntimeSessionGoalHarnessResolver(() => getWorkflowData()),
			scopeGuard: new LifecycleSessionGoalScopeGuard(),
			userEvents: new DaprSessionUserEventCommandAdapter(
				getSessionEvents(),
				getSessionRuntimeEvents(),
			),
		}));
	const getInternalGoalControl = () =>
		(internalGoalControl ??= new ApplicationInternalGoalControlService({
			evaluator: new LegacyGoalCompletionEvaluator({
				goals: getSessionGoalStore(),
				workflowData: getWorkflowData(),
			}),
			finalizer: new LegacyCompletedWorkflowGoalFinalizer(getGoalLoopStore()),
			goals: getSessionGoalStore(),
			goalLoop: new DaprSessionGoalLoopDriver(getGoalLoopStore()),
			sessionEvents: getSessionEvents(),
			rejectionIds: new DateGoalRejectionSourceEventIdPort(),
		}));
	const getLifecycleCoordinatorOwners = () =>
		new PostgresLifecycleCoordinatorOwnerStore(getDatabase);
	const getSessionLifecycle = () =>
		(sessionLifecycle ??= new ApplicationSessionLifecycleService({
			sessions: getSessions(),
			lifecycle: new LifecycleSessionController(
				getSessionGoalStore(),
				getLifecycleCoordinatorOwners(),
			),
		}));
	const getBulkLifecycleStop = () =>
		(bulkLifecycleStop ??= new ApplicationBulkLifecycleStopService({
			sessionLifecycle: new LifecycleSessionController(
				getSessionGoalStore(),
				getLifecycleCoordinatorOwners(),
			),
			workflowLifecycle: new LifecycleWorkflowExecutionControllerPort(),
			workflowCoordinatorOwners:
				new LifecycleWorkflowExecutionCoordinatorOwnerPort(
					getLifecycleCoordinatorOwners(),
				),
			benchmarkRuns: new ServiceBenchmarkRunCancellationPort(),
			evaluationRuns: new ServiceEvaluationRunCancellationPort(),
			coordinatorCancels: new DaprLifecycleCoordinatorCancelNotifier(),
		}));
	const getRunCancellation = () =>
		(runCancellation ??= new ApplicationRunCancellationService({
			benchmarkRuns: new ServiceBenchmarkRunCancellationPort(),
			evaluationRuns: new ServiceEvaluationRunCancellationPort(),
			coordinator: new DaprCoordinatorCancelAdapter(),
		}));
	const getBenchmarkRunLaunch = () =>
		(benchmarkRunLaunch ??= new ApplicationBenchmarkRunLaunchService(
			new LegacyBenchmarkRunLaunchAdapter(),
		));
	const getBenchmarkCapacityDiagnostics = () =>
		(benchmarkCapacityDiagnostics ??=
			new ApplicationBenchmarkCapacityDiagnosticsService(
				new LegacyBenchmarkCapacityDiagnosticsAdapter(),
			));
	const getBenchmarkEnvironmentValidation = () =>
		(benchmarkEnvironmentValidation ??=
			new ApplicationBenchmarkEnvironmentValidationService({
				repository: new PostgresSwebenchEnvironmentValidationRepository(),
				provisioner: new LegacySwebenchEnvironmentBuildProvisioner(),
			}));
	const getEvaluationRunLaunch = () =>
		(evaluationRunLaunch ??= new ApplicationEvaluationRunLaunchService(
			new LegacyEvaluationRunLaunchAdapter(),
		));
	const getEvaluationDatasets = () =>
		(evaluationDatasets ??= new ApplicationEvaluationDatasetService(
			new LegacyEvaluationDatasetRepository(),
		));
	const getEvaluationTemplates = () =>
		(evaluationTemplates ??= new ApplicationEvaluationTemplateService({
			templates: new LegacyEvaluationTemplateRepository(),
			imports: new LegacyEvaluationDatasetImportParser(),
			swebenchSuites: new StaticSwebenchSuiteCatalog(),
		}));
	const getEnvironments = () =>
		(environments ??= new ApplicationEnvironmentService(
			new LegacyEnvironmentRepository(),
			new PostgresEnvironmentMaintenanceRepository(),
		));
	const getVaultsService = () =>
		(vaultsService ??= new ApplicationVaultService(
			new LegacyVaultRepository(),
		));
	const getVaultCredentialRepository = () =>
		(vaultCredentialRepository ??= new PostgresVaultCredentialRepository());
	const getVaultCredentialsService = () =>
		(vaultCredentialsService ??= new ApplicationVaultCredentialService(
			getVaultCredentialRepository(),
			new LegacyVaultRepository(),
		));
	const getEvaluationRunDetail = () =>
		(evaluationRunDetail ??= new ApplicationEvaluationRunDetailService(
			new LegacyEvaluationRunDetailReadAdapter(),
		));
	const getBenchmarkRunDetail = () =>
		(benchmarkRunDetail ??= new ApplicationBenchmarkRunDetailPageService(
			new LegacyBenchmarkRunDetailReadAdapter(),
		));
	const getBenchmarkRunInstanceDetail = () =>
		(benchmarkRunInstanceDetail ??=
			new ApplicationBenchmarkRunInstanceDetailService({
				workflowData: getWorkflowData(),
				mlflowLinks: new EnvBenchmarkRunInstanceMlflowLinks(),
			}));
	const getBenchmarkCompare = () =>
		(benchmarkCompare ??= new ApplicationBenchmarkCompareService(
			getBenchmarkRunReads(),
		));
	const getCapacityActive = () =>
		(capacityActive ??= new ApplicationCapacityActiveService({
			fleetActivity: new SessionFleetActivityAdapter(),
		}));
	const getCapacityOverview = () =>
		(capacityOverview ??= new ApplicationCapacityOverviewService({
			metrics: new ClickHouseCapacityMetricsAdapter(),
			observer: new HttpCapacityObserverAdapter(),
			ownership: new LegacyCapacityOwnershipAdapter(),
			businessWork: new LegacyCapacityBusinessWorkAdapter(),
			telemetry: new OtelCapacityRemoteTelemetryAdapter(),
		}));
	const getDaprInspection = () =>
		(daprInspection ??= new ApplicationDaprInspectionService({
			runtime: new DaprClientInspectionRuntimeAdapter(),
		}));
	const getRuntimeCatalog = () =>
		(runtimeCatalog ??= new ApplicationRuntimeCatalogService(
			new LocalRuntimeCatalogReader(),
		));
	const getCodeFunctionStore = () =>
		(codeFunctionStore ??= new PostgresCodeFunctionStore(getDatabase()));
	const getCatalogFunctionDefinition = () =>
		(catalogFunctionDefinition ??=
			new ApplicationCatalogFunctionDefinitionService(
				new PostgresCatalogFunctionDefinitionReader(getCodeFunctionStore()),
			));
	const getActionCatalog = () =>
		(actionCatalog ??= new ApplicationActionCatalogService(
			new LegacyActionCatalogReader(getCodeFunctionStore()),
		));
	const getWorkflowTriggerKindCatalog = () =>
		(workflowTriggerKindCatalog ??=
			new ApplicationWorkflowTriggerKindCatalogService(
				new LocalWorkflowTriggerKindCatalogReader(),
			));
	const getActionOptions = () =>
		(actionOptions ??= new ApplicationActionOptionsService({
			actions: new LocalActionOptionsCatalogReader(getCodeFunctionStore()),
			codeFunctions: new LocalCodeFunctionOptionsPort(
				getCodeFunctionOptions(),
				getCodeFunctionStore(),
			),
			connections: new WorkflowDataActionOptionsConnectionReader(),
			pieces: new DaprPieceOptionsClient(),
		}));
	const getActionCatalogTest = () =>
		(actionCatalogTest ??= new ApplicationActionCatalogTestService({
			actions: new LocalActionCatalogTestReader(getCodeFunctionStore()),
			codeFunctions: new PostgresCodeFunctionExecutionRepository(
				getCodeFunctionStore(),
			),
			functionRouter: new DaprFunctionRouterExecutionPort(),
			http: new DaprActionCatalogHttpTestClient(),
			ids: new DateActionCatalogTestExecutionIdGenerator(),
		}));
	const getCodeFunctionManagement = () =>
		(codeFunctionManagement ??= new ApplicationCodeFunctionManagementService(
			new PostgresCodeFunctionManagementRepository(getCodeFunctionStore()),
		));
	const getCodeFunctionParsePreview = () =>
		(codeFunctionParsePreview ??=
			new ApplicationCodeFunctionParsePreviewService(
				new LocalCodeFunctionParsePreviewPort(),
			));
	const getCodeFunctionOptions = () =>
		(codeFunctionOptions ??= new ApplicationCodeFunctionOptionsService({
			codeFunctions: new PostgresCodeFunctionOptionsRepository(
				getCodeFunctionStore(),
			),
			runtime: new DaprCodeFunctionOptionsRuntimeClient(),
		}));
	const getCodeFunctionExecution = () =>
		(codeFunctionExecution ??= new ApplicationCodeFunctionExecutionService({
			codeFunctions: new PostgresCodeFunctionExecutionRepository(
				getCodeFunctionStore(),
			),
			functionRouter: new DaprFunctionRouterExecutionPort(),
			ids: new DateCodeFunctionExecutionIdGenerator(),
		}));
	const getCliCredentials = () =>
		(cliCredentials ??= new ApplicationCliCredentialsService({
			userStore: new PostgresUserCliCredentialStore(),
			hostStore: new RawPostgresHostCliCredentialStore(),
		}));
	const getSettingsCliTokens = () =>
		(settingsCliTokens ??= new ApplicationSettingsCliTokensService({
			runtimes: new LocalSettingsCliRuntimeCatalogReader(),
			credentials: getCliCredentials(),
		}));
	const getPromptPresets = () =>
		(promptPresets ??= new ApplicationPromptPresetService(
			new PostgresPromptPresetRepository(),
		));
	const getPromptStackCompiler = () =>
		(promptStackCompiler ??= new ApplicationPromptStackCompilerService(
			new PostgresPromptStackPresetReadRepository(),
		));
	const getSessionSandboxes = () =>
		(sessionSandboxes ??= new ApplicationSessionSandboxService({
			sessions: getSessions(),
			lifecycle: new LifecycleSessionController(
				getSessionGoalStore(),
				getLifecycleCoordinatorOwners(),
			),
			sandboxes: new KubernetesSessionSandboxDestroyer(),
		}));
	const getSandboxEvents = () =>
		(sandboxEvents ??= new ApplicationSandboxEventsService(
			new PostgresSandboxAgentEventReadPort(),
		));
	const getSessionMcpStatus = () =>
		(sessionMcpStatus ??= new ApplicationSessionMcpStatusService({
			workflowData: getWorkflowData(),
			agentConfigs: new RegistrySessionMcpAgentConfigReader(),
			credentials: new VaultSessionMcpCredentialStatusReader(),
		}));
	const getSessionRuntimeAccess = () => {
		if (sessionRuntimeAccess) return sessionRuntimeAccess;
		const runtimeStatus = new KubernetesSessionRuntimeStatusReader();
		sessionRuntimeAccess = new ApplicationSessionRuntimeAccessService({
			workflowData: getWorkflowData(),
			pods: runtimeStatus,
			capabilities: runtimeStatus,
		});
		return sessionRuntimeAccess;
	};
	const getPeerSessionSpawn = () =>
		(peerSessionSpawn ??= new ApplicationPeerSessionSpawnService({
			workflowData: getWorkflowData(),
			workflowSpawner: getWorkflowSpawner(),
		}));
	const getCodeCheckpoints = () =>
		(codeCheckpoints ??= new PostgresWorkflowCodeCheckpointStore(
			getDatabase(),
		));
	const getEvaluationArtifacts = () =>
		(evaluationArtifacts ??= new PostgresEvaluationArtifactStore(
			getDatabase(),
		));
	const getAgentRuntimeWarmPools = () =>
		(agentRuntimeWarmPools ??= new KubernetesAgentRuntimeWarmPoolClient());
	const getAgentRuntimeControl = () =>
		(agentRuntimeControl ??= new ApplicationAgentRuntimeControlService({
			agentRuntimes: getAgentRuntimes(),
			workspaceProjects: getWorkspaceProjects(),
			warmPools: getAgentRuntimeWarmPools(),
		}));
	const getBenchmarkInstanceLifecycle = () =>
		(benchmarkInstanceLifecycle ??=
			new ApplicationBenchmarkInstanceLifecycleService(
				new LegacyBenchmarkInstanceLifecycleAdapter(),
			));
	const getAgentCatalog = () =>
		(agentCatalog ??= new ApplicationAgentCatalogService({
			agents: new LegacyAgentCatalogRepository(),
			capabilities: new LegacyAgentCompiledCapabilitiesRepository(),
			registry: new LegacyAgentRegistryRepository(),
			runtimes: new LocalAgentRuntimeCatalog(),
			templates: new LocalAgentTemplateCatalog(),
		}));
	const getAgentImportExport = () =>
		(agentImportExport ??= new ApplicationAgentImportExportService({
			agents: new LegacyAgentCatalogRepository(),
			references: new LegacyAgentImportExportReferenceRepository(),
		}));
	const getAgentProfiles = () =>
		(agentProfiles ??= new ApplicationAgentProfileService(
			new PostgresAgentProfileReadRepository(),
		));
	const getAgentRegistryBrowser = () =>
		(agentRegistryBrowser ??= new ApplicationAgentRegistryBrowserService({
			registryState: new DaprAgentRegistryStateReaderAdapter(),
		}));
	const getWorkflowDefinitionCommands = () =>
		(workflowDefinitionCommands ??=
			new ApplicationWorkflowDefinitionCommandService({
				workflowData: getWorkflowData(),
				connectionRefs: new PostgresWorkflowConnectionRefSyncPort(),
			}));
	const getWorkflowExecutionControl = () =>
		(workflowExecutionControl ??=
			new ApplicationWorkflowExecutionControlService({
				workflowData: getWorkflowData(),
				approvalEvents: new DaprWorkflowApprovalEventPort(),
				coordinatorOwners: new LifecycleWorkflowExecutionCoordinatorOwnerPort(),
				executionLifecycle: new LifecycleWorkflowExecutionControllerPort(),
				executionReadModels: getWorkflowExecutionReadModels(),
				runStarter: new LegacyWorkflowRunStarterPort(),
				workflowSpecs: new LegacyWorkflowSpecValidatorPort(),
			}));
	const getTriggeredWorkflowStart = () =>
		(triggeredWorkflowStart ??= new ApplicationTriggeredWorkflowStartService({
			admission: new LegacyTriggeredRunAdmissionPort(),
			executionIds: new ShaTriggeredWorkflowExecutionIdPort(),
			runStarter: new LegacyWorkflowRunStarterPort(),
		}));
	const getWorkflowExecutionArtifacts = () =>
		(workflowExecutionArtifacts ??=
			new ApplicationWorkflowExecutionArtifactsService({
				workflowData: getWorkflowData(),
			}));
	const getWorkflowExecutionArtifactDiff = () =>
		(workflowExecutionArtifactDiff ??=
			new ApplicationWorkflowExecutionArtifactDiffService({
				workflowData: getWorkflowData(),
				diffKind: RUN_DIFF_KIND,
				resolveDiff: resolveRunDiffPatch,
			}));
	const getWorkflowExecutionFiles = () =>
		(workflowExecutionFiles ??= new ApplicationWorkflowExecutionFilesService({
			workflowData: getWorkflowData(),
		}));
	const getWorkflowExecutionLineage = () =>
		(workflowExecutionLineage ??=
			new ApplicationWorkflowExecutionLineageService({
				workflowData: getWorkflowData(),
			}));
	const getWorkflowExecutionLogs = () =>
		(workflowExecutionLogs ??= new ApplicationWorkflowExecutionLogsService({
			workflowData: getWorkflowData(),
			traceExtractor: extractExecutionTraceIds,
		}));
	const getWorkflowExecutionMetrics = () =>
		(workflowExecutionMetrics ??=
			new ApplicationWorkflowExecutionMetricsService({
				workflowData: getWorkflowData(),
				pricing: { costFor, formatCurrency },
			}));
	const getWorkflowExecutionSessions = () =>
		(workflowExecutionSessions ??=
			new ApplicationWorkflowExecutionSessionsService({
				workflowData: getWorkflowData(),
			}));
	const getWorkflowExecutionSpecDiff = () =>
		(workflowExecutionSpecDiff ??=
			new ApplicationWorkflowExecutionSpecDiffService({
				workflowData: getWorkflowData(),
			}));
	const getWorkflowExecutionWorkspace = () =>
		(workflowExecutionWorkspace ??=
			new ApplicationWorkflowExecutionWorkspaceService({
				workflowData: getWorkflowData(),
				workspace: new JuiceFsWorkflowExecutionWorkspaceAdapter(),
			}));
	const getWorkflowExecutionReadModels = () =>
		(workflowExecutionReadModels ??=
			new ApplicationWorkflowExecutionReadModelService({
				workflowData: getWorkflowData(),
				runtimeStatus: new DaprWorkflowRuntimeStatusPort(),
				traceExtractor: extractExecutionTraceIds,
			}));
	const getWorkflowExecutionStream = () =>
		(workflowExecutionStream ??= new ApplicationWorkflowExecutionStreamService({
			workflowData: getWorkflowData(),
			executionReadModels: getWorkflowExecutionReadModels(),
		}));
	const getWorkflowBrowserArtifacts = () =>
		(workflowBrowserArtifacts ??=
			new ApplicationWorkflowBrowserArtifactsService({
				workflowData: getWorkflowData(),
			}));
	const getWorkflowCodeCheckpoints = () =>
		(workflowCodeCheckpoints ??= new ApplicationWorkflowCodeCheckpointService({
			checkpoints: getCodeCheckpoints(),
			workspace: new LegacyWorkflowCodeCheckpointWorkspacePort(),
		}));
	const getWorkflowCodeVersions = () =>
		(workflowCodeVersions ??= new ApplicationWorkflowCodeVersionService({
			workflowData: getWorkflowData(),
			promotionGate: new WorkflowPromotionGateAdapter(),
		}));
	const getWorkflowCodeVersionPromotion = () =>
		(workflowCodeVersionPromotion ??=
			new ApplicationWorkflowCodeVersionPromotionService({
				workflowData: getWorkflowData(),
				promotionGate: new WorkflowPromotionGateAdapter(),
				runner: new HelperPodSourceBundlePromotionRunner(),
			}));
	const getWorkflowTriggerLifecycle = () =>
		(workflowTriggerLifecycle ??=
			new ApplicationWorkflowTriggerLifecycleService({
				workflowData: getWorkflowData(),
				lifecycle: new WorkflowTriggerLifecycleAdapter(getWorkflowTriggers()),
			}));
	const getWorkflowTriggerManagement = () =>
		(workflowTriggerManagement ??=
			new ApplicationWorkflowTriggerManagementService({
				workflowData: getWorkflowData(),
			}));
	const getWorkflowPlan = () =>
		(workflowPlan ??= new ApplicationWorkflowPlanService({
			workflowData: getWorkflowData(),
			legacyAgentPlans: new DaprLegacyAgentPlanReader(),
		}));
	const getGitOpsActivityEvents = () =>
		(gitOpsActivityEvents ??= new ApplicationGitOpsActivityEventService(
			new PostgresGitOpsActivityEventStore(),
		));
	const getCliPreview = () =>
		(cliPreview ??= new ApplicationCliPreviewService({
			preview: new LegacyCliPreviewGatewayPort(getWorkflowData()),
		}));
	const getSandboxPreview = () =>
		(sandboxPreview ??= new ApplicationSandboxPreviewService({
			preview: new LegacySandboxPreviewGatewayPort(getWorkflowData()),
			workflowData: getWorkflowData(),
		}));
	const getSessionCommands = () =>
		(sessionCommands ??= new ApplicationSessionCommandService({
			sessions: getSessions(),
			sessionEvents: getSessionEvents(),
			sessionAgents: getPeerAgentResolver(),
			sessionAgentSlugs: getPeerAgentResolver(),
			sessionExperimentAgents: getPeerAgentResolver(),
			sandboxProvisioner: getSandboxProvisioner(),
			repositoryMounter: getRepositoryMounter(),
			workflowSpawner: getWorkflowSpawner(),
			workspaceProjects: getWorkspaceProjects(),
			sessionTraceLifecycle: getSessionTraceLifecycle(),
			sandboxDestroyer: new KubernetesSessionSandboxDestroyer(),
			workflowEphemeralAgents: new LegacyWorkflowEphemeralAgentStore(),
			agentRuntimeSync: new AgentRuntimeRegistrySyncAdapter(),
		}));
	const getSessionAgentConfig = () =>
		(sessionAgentConfig ??= new ApplicationSessionAgentConfigService({
			patches: getWorkflowData(),
		}));
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
			adminPieceRuntimeImages: new LegacyAdminPieceRuntimeImageRegistryPort(),
			adminPieceRuntimeImageBuilds: new LegacyAdminPieceRuntimeImageBuildPort(),
			apiKeys: getApiKeys(),
			workspaceProjects: getWorkspaceProjects(),
			pieceCatalog: getPieceCatalog(),
			pieceExecutions: getPieceExecutions(),
			browserArtifacts: getBrowserArtifacts(),
			codeFunctionCatalog: getCodeFunctionCatalog(),
			benchmarkArtifactMetadata: getBenchmarkArtifactMetadata(),
			benchmarkEvaluationResults: getBenchmarkEvaluationResults(),
			benchmarkRunLifecycle: new LegacyBenchmarkRunLifecycleAdapter(),
			benchmarkEvaluationTelemetry:
				new LegacyBenchmarkEvaluationTelemetryAdapter(),
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
			modelCatalog: getModelCatalog(),
			workflowExecutions: getWorkflowExecutions(),
			sessions: getSessions(),
			sessionProvisioning: getSessionProvisioning(),
			sessionEvents: getSessionEvents(),
			sessionRuntimeConfigs: getSessionRuntimeConfigs(),
			sessionRuntimeEvents: getSessionRuntimeEvents(),
			sessionAgents: getPeerAgentResolver(),
			sessionAgentSlugs: getPeerAgentResolver(),
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
	const getPreviewEnvironmentProvisioner = () =>
		(previewEnvironmentProvisioner ??=
			config.previewProvisionerAdapter === "kro"
				? new KroPreviewEnvironmentProvisioner()
				: new SandboxExecutionPreviewEnvironmentProvisioner(
						getWorkflowData,
						new PostgresPreviewDatabaseProvisioner(),
					));
	const getWorkflowExport = () =>
		(workflowExport ??= new ApplicationWorkflowExportService({
			workflowData: getWorkflowData(),
			emitter: new LegacyWorkflowEmitterAdapter(getCodeFunctionStore()),
			codeFunctions: new PostgresWorkflowCodeFunctionAdapter(
				getCodeFunctionStore(),
			),
			now: () => new Date(),
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
		get workflowExport() {
			return getWorkflowExport();
		},
		get sessionCommands() {
			return getSessionCommands();
		},
		get sessionAgentConfig() {
			return getSessionAgentConfig();
		},
		get sessionGoals() {
			return getSessionGoals();
		},
		get sessionGoalStore() {
			return getSessionGoalStore();
		},
		get internalGoalControl() {
			return getInternalGoalControl();
		},
		get sessionLifecycle() {
			return getSessionLifecycle();
		},
		get bulkLifecycleStop() {
			return getBulkLifecycleStop();
		},
		get runCancellation() {
			return getRunCancellation();
		},
		get benchmarkRunLaunch() {
			return getBenchmarkRunLaunch();
		},
		get benchmarkCapacityDiagnostics() {
			return getBenchmarkCapacityDiagnostics();
		},
		get benchmarkEnvironmentValidation() {
			return getBenchmarkEnvironmentValidation();
		},
		get benchmarkInstanceLifecycle() {
			return getBenchmarkInstanceLifecycle();
		},
		get evaluationRunLaunch() {
			return getEvaluationRunLaunch();
		},
		get evaluationDatasets() {
			return getEvaluationDatasets();
		},
		get evaluationTemplates() {
			return getEvaluationTemplates();
		},
		get environments() {
			return getEnvironments();
		},
		get vaults() {
			return getVaultsService();
		},
		get vaultCredentials() {
			return getVaultCredentialsService();
		},
		get evaluationRunDetail() {
			return getEvaluationRunDetail();
		},
		get benchmarkRunDetail() {
			return getBenchmarkRunDetail();
		},
		get benchmarkRunInstanceDetail() {
			return getBenchmarkRunInstanceDetail();
		},
		get benchmarkCompare() {
			return getBenchmarkCompare();
		},
		get capacityActive() {
			return getCapacityActive();
		},
		get capacityOverview() {
			return getCapacityOverview();
		},
		get daprInspection() {
			return getDaprInspection();
		},
		get runtimeCatalog() {
			return getRuntimeCatalog();
		},
		get catalogFunctionDefinition() {
			return getCatalogFunctionDefinition();
		},
		get actionCatalog() {
			return getActionCatalog();
		},
		get workflowTriggerKindCatalog() {
			return getWorkflowTriggerKindCatalog();
		},
		get actionOptions() {
			return getActionOptions();
		},
		get actionCatalogTest() {
			return getActionCatalogTest();
		},
		get observabilityTraceAccess() {
			return getObservabilityTraceAccess();
		},
		get capabilityBundles() {
			return getCapabilityBundles();
		},
		get agentSkills() {
			return getAgentSkills();
		},
		get resourceMetrics() {
			return getResourceMetrics();
		},
		get sandboxActiveGuard() {
			return getSandboxActiveGuard();
		},
		get codeFunctionManagement() {
			return getCodeFunctionManagement();
		},
		get codeFunctionParsePreview() {
			return getCodeFunctionParsePreview();
		},
		get codeFunctionOptions() {
			return getCodeFunctionOptions();
		},
		get codeFunctionExecution() {
			return getCodeFunctionExecution();
		},
		get cliCredentials() {
			return getCliCredentials();
		},
		get settingsCliTokens() {
			return getSettingsCliTokens();
		},
		get promptPresets() {
			return getPromptPresets();
		},
		get promptStackCompiler() {
			return getPromptStackCompiler();
		},
		get sessionSandboxes() {
			return getSessionSandboxes();
		},
		get sessionMcpStatus() {
			return getSessionMcpStatus();
		},
		get sessionRuntimeAccess() {
			return getSessionRuntimeAccess();
		},
		get peerSessionSpawn() {
			return getPeerSessionSpawn();
		},
		get agentRuntimeControl() {
			return getAgentRuntimeControl();
		},
		get agentCatalog() {
			return getAgentCatalog();
		},
		get agentImportExport() {
			return getAgentImportExport();
		},
		get agentSkillHydration() {
			return getAgentSkillHydration();
		},
		get agentProfiles() {
			return getAgentProfiles();
		},
		get agentRegistryBrowser() {
			return getAgentRegistryBrowser();
		},
		get workflowDefinitionCommands() {
			return getWorkflowDefinitionCommands();
		},
		get workflowExecutionControl() {
			return getWorkflowExecutionControl();
		},
		get triggeredWorkflowStart() {
			return getTriggeredWorkflowStart();
		},
		get workflowExecutionArtifacts() {
			return getWorkflowExecutionArtifacts();
		},
		get workflowExecutionArtifactDiff() {
			return getWorkflowExecutionArtifactDiff();
		},
		get workflowExecutionFiles() {
			return getWorkflowExecutionFiles();
		},
		get workflowExecutionLineage() {
			return getWorkflowExecutionLineage();
		},
		get workflowExecutionLogs() {
			return getWorkflowExecutionLogs();
		},
		get workflowExecutionMetrics() {
			return getWorkflowExecutionMetrics();
		},
		get workflowExecutionSessions() {
			return getWorkflowExecutionSessions();
		},
		get workflowExecutionSpecDiff() {
			return getWorkflowExecutionSpecDiff();
		},
		get workflowExecutionWorkspace() {
			return getWorkflowExecutionWorkspace();
		},
		get workflowExecutionStream() {
			return getWorkflowExecutionStream();
		},
		get workflowBrowserArtifacts() {
			return getWorkflowBrowserArtifacts();
		},
		get workflowCodeCheckpoints() {
			return getWorkflowCodeCheckpoints();
		},
		get workflowCodeVersions() {
			return getWorkflowCodeVersions();
		},
		get workflowCodeVersionPromotion() {
			return getWorkflowCodeVersionPromotion();
		},
		get workflowTriggerLifecycle() {
			return getWorkflowTriggerLifecycle();
		},
		get workflowTriggerManagement() {
			return getWorkflowTriggerManagement();
		},
		get workflowPlan() {
			return getWorkflowPlan();
		},
		get gitOpsActivityEvents() {
			return getGitOpsActivityEvents();
		},
		get cliPreview() {
			return getCliPreview();
		},
		get sandboxPreview() {
			return getSandboxPreview();
		},
		get sandboxEvents() {
			return getSandboxEvents();
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
		get sandboxProvisioner() {
			return getSandboxProvisioner();
		},
		previewEnvironmentProvisioner: getPreviewEnvironmentProvisioner(),
	};
}
