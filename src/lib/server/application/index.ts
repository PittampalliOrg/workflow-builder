import {
  getApplicationAdapterConfig,
  type ApplicationAdapterConfig,
} from "$lib/server/application/config";
import { env } from "$env/dynamic/private";
import type {
  ArtifactStore,
  WorkflowBrowserArtifactStore,
  WorkflowExecutionRepository,
  WorkflowPlanArtifactStore,
  PrPreviewCommandPort,
} from "$lib/server/application/ports";
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
import {
  DaprPostgresWorkflowBrowserArtifactStore,
  PostgresWorkflowBrowserArtifactBlobPayloadStore,
} from "$lib/server/application/adapters/workflow-browser-artifacts-dapr-postgres";
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
  DateAuthIdGenerator,
  JwtAuthTokenIssuer,
  PostgresAuthSignInRepository,
} from "$lib/server/application/adapters/auth-sign-in";
import {
  LegacyAuthAccessTokenVerifier,
  LegacyAuthSessionReader,
  LegacyAuthTokenRefresher,
} from "$lib/server/application/adapters/auth-session";
import {
  LegacyAgentCompiledCapabilitiesRepository,
  AgentRuntimeRegistrySyncAdapter,
  LegacyAgentCatalogRepository,
  LegacyAgentRegistryRepository,
  PostgresWorkflowEphemeralAgentStore,
  LocalAgentRuntimeCatalog,
  LocalAgentTemplateCatalog,
  PostgresAgentSkillHydrationRepository,
  RegistryPeerAgentResolver,
} from "$lib/server/application/adapters/agents";
import { PostgresAgentInlineBackfillRepository } from "$lib/server/application/adapters/agent-backfill";
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
import { LiteStubWorkflowScheduler } from "$lib/server/application/adapters/in-process";
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
import { PostgresBenchmarkMlflowEvaluationRepository } from "$lib/server/application/adapters/benchmark-mlflow-evaluation";
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
  LegacyEvaluationDefinitionRepository,
  LegacyEvaluationRunRepository,
  LegacyEvaluationRunItemRepository,
  LegacyEvaluationTemplateRepository,
  StaticSwebenchSuiteCatalog,
} from "$lib/server/application/adapters/evaluations";
import {
  LegacyEnvironmentRepository,
  LegacyEnvironmentRuntimeResolver,
} from "$lib/server/application/adapters/environments";
import { LegacyEnvironmentBuildActivityReadAdapter } from "$lib/server/application/adapters/environment-build-activity";
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
import { createDaprPostgresSessionEventLog } from "$lib/server/application/adapters/session-events-dapr-postgres";
import { PostgresGoalLoopStore } from "$lib/server/application/adapters/goal-loop-store";
import { PostgresTeamStore } from "$lib/server/application/adapters/team-store";
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
import { LegacyDeploymentMetadataGateway } from "$lib/server/application/adapters/gitops-deployment";
import { LegacyPromotionStateGateway } from "$lib/server/application/adapters/gitops-promotions";
import { JuiceFsWorkflowExecutionWorkspaceAdapter } from "$lib/server/application/adapters/workflow-execution-workspace";
import { LegacyCliPreviewGatewayPort } from "$lib/server/application/adapters/cli-preview";
import { LegacySandboxPreviewGatewayPort } from "$lib/server/application/adapters/sandbox-preview";
import { WorkflowTriggerLifecycleAdapter } from "$lib/server/application/adapters/workflow-trigger-lifecycle";
import { getEventBusAdapter } from "$lib/server/application/event-bus";
import { ApplicationAgentRuntimeControlService } from "$lib/server/application/agent-runtime-control";
import { ApplicationAgentBackfillService } from "$lib/server/application/agent-backfill";
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
import { ApplicationBenchmarkRouteOperationsService } from "$lib/server/application/benchmark-route-operations";
import { ApplicationEvaluationDefinitionService } from "$lib/server/application/evaluation-definitions";
import { ApplicationEvaluationDatasetService } from "$lib/server/application/evaluation-datasets";
import { ApplicationEvaluationRunService } from "$lib/server/application/evaluation-runs";
import { ApplicationEvaluationRunItemService } from "$lib/server/application/evaluation-run-items";
import { ApplicationEvaluationTemplateService } from "$lib/server/application/evaluation-templates";
import { ApplicationEnvironmentService } from "$lib/server/application/environment-management";
import { ApplicationEnvironmentBuildActivityService } from "$lib/server/application/environment-build-activity";
import { ApplicationVaultService } from "$lib/server/application/vault-management";
import { ApplicationVaultCredentialService } from "$lib/server/application/vault-credentials";
import { ApplicationBenchmarkCapacityDiagnosticsService } from "$lib/server/application/benchmark-capacity-diagnostics";
import { ApplicationBenchmarkEnvironmentValidationService } from "$lib/server/application/benchmark-environment-validation";
import { ApplicationBenchmarkInstanceLifecycleService } from "$lib/server/application/benchmark-instance-lifecycle";
import { ApplicationBenchmarkRunInstanceDetailService } from "$lib/server/application/benchmark-run-instance-detail";
import { ApplicationBenchmarkMlflowEvaluationService } from "$lib/server/application/benchmark-mlflow-evaluation";
import { LegacyBenchmarkRouteOperationsAdapter } from "$lib/server/application/adapters/benchmark-route-operations";
import { ApplicationRunCancellationService } from "$lib/server/application/run-cancellation";
import { ApplicationEvaluationRunDetailService } from "$lib/server/application/evaluation-run-detail";
import { ApplicationWorkflowDefinitionCommandService } from "$lib/server/application/workflow-definition-commands";
import { ApplicationWorkflowExportService } from "$lib/server/application/workflow-export";
import { ApplicationWorkflowBrowserArtifactsService } from "$lib/server/application/workflow-browser-artifacts";
import { ApplicationWorkflowExecutionArtifactDiffService } from "$lib/server/application/workflow-execution-artifact-diff";
import { ApplicationWorkflowExecutionArtifactsService } from "$lib/server/application/workflow-execution-artifacts";
import { ApplicationScriptCallsService } from "$lib/server/application/script-calls";
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
import { ApplicationPreviewRunFeedService } from "$lib/server/application/preview-run-feed";
import { NatsPreviewRunFeed } from "$lib/server/application/adapters/nats-preview-run-feed";
import { DaprPostgresScriptCallsStore } from "$lib/server/application/adapters/script-calls-dapr-postgres";
import { DaprPostgresWorkflowExecutionRepository } from "$lib/server/application/adapters/workflow-executions-dapr-postgres";
import {
  DaprPostgresArtifactStore,
  DaprPostgresWorkflowPlanArtifactStore,
} from "$lib/server/application/adapters/workflow-artifacts-dapr-postgres";
import { listVclusterPreviews } from "$lib/server/workflows/vcluster-preview";
import {
  ApplicationPrPreviewFacadeService,
  ApplicationPrPreviewService,
} from "$lib/server/application/pr-previews";
import {
  GithubPrPreviewGateway,
  HelperPodPrHeadSeeder,
  HttpPrPreviewCommandBrokerAdapter,
  PreviewBffDevPodGateway,
  prPreviewRegistryEntries,
  prPreviewSyncToken,
  WorkflowDispatchPrPreviewVerifyRunner,
} from "$lib/server/application/adapters/pr-previews";
import { DrizzlePrPreviewRecordStore } from "$lib/server/application/adapters/pr-preview-records";
import { ApplicationPreviewReadProxyService } from "$lib/server/application/preview-read-proxy";
import { ApplicationPreviewArchiveService } from "$lib/server/application/preview-archive";
import { ApplicationPreviewAccessService } from "$lib/server/application/preview-access";
import { ApplicationPreviewLifecycleReaperService } from "$lib/server/application/preview-lifecycle-reaper";
import { ApplicationPreviewReadBrokerService } from "$lib/server/application/preview-read-broker";
import {
  HmacPreviewControlCapabilityMintAdapter,
  HttpPreviewCapabilityReadTransportAdapter,
  HttpPreviewReadBrokerAdapter,
} from "$lib/server/application/adapters/preview-read-broker";
import { ApplicationVclusterPreviewService } from "$lib/server/application/vcluster-previews";
import { ApplicationDevPreviewSidecarService } from "$lib/server/application/dev-preview-sidecar";
import { ApplicationDevPreviewSourceCaptureService } from "$lib/server/application/dev-preview-source-capture";
import { ApplicationPreviewSessionContinuationService } from "$lib/server/application/preview-session-continuation";
import {
  LegacyVclusterPreviewGateway,
  LegacyDevPreviewSidecarGateway,
  LegacyPreviewEnvironmentCleanupReceiptAdapter,
} from "$lib/server/application/adapters/dev-previews";
import { LegacyDevPreviewSourceCaptureAdapter } from "$lib/server/application/adapters/dev-preview-source-capture";
import {
  GithubPreviewEnvironmentRevisionResolver,
  HttpPreviewEnvironmentLaunchBrokerAdapter,
  OperatorManagedInfrastructurePreviewEnvironmentLaunchAdapter,
  SeaVclusterPreviewEnvironmentLaunchAdapter,
} from "$lib/server/application/adapters/preview-environments";
import { DevPreviewServiceCatalogAdapter } from "$lib/server/application/adapters/dev-preview-service-catalog";
import {
  BrokeredVclusterPreviewGateway,
  DesiredStateVclusterPreviewGateway,
  KubernetesPreviewEnvironmentDesiredStateAdapter,
  previewEnvironmentHubKubeFetch,
} from "$lib/server/application/adapters/preview-environment-desired-state";
import { ApplicationPreviewEnvironmentLifecycleBrokerService } from "$lib/server/application/preview-environment-lifecycle-broker";
import { ApplicationPreviewEnvironmentDeletionReconcilerService } from "$lib/server/application/preview-environment-deletion-reconciler";
import { ManifestCandidatePathPolicyAdapter } from "$lib/server/application/adapters/preview-candidate-paths";
import { ApplicationPreviewEnvironmentService } from "$lib/server/application/preview-environments";
import { ApplicationPreviewEnvironmentLaunchBrokerService } from "$lib/server/application/preview-environment-launch-broker";
import { ApplicationPreviewEnvironmentAcceptanceService } from "$lib/server/application/preview-environment-acceptance";
import { ApplicationPreviewAcceptanceTrustService } from "$lib/server/application/preview-acceptance-trust";
import { ApplicationPreviewDevelopmentBuildService } from "$lib/server/application/preview-development-build";
import { ApplicationPreviewDevelopmentBuildBrokerService } from "$lib/server/application/preview-development-build-broker";
import { ApplicationPreviewInfrastructureCandidateBrokerService } from "$lib/server/application/preview-infrastructure-candidate-broker";
import { ApplicationPreviewPrAdoptionService } from "$lib/server/application/preview-pr-adoption";
import { ApplicationPreviewArtifactIngressService } from "$lib/server/application/preview-artifact-ingress";
import { ApplicationPreviewAcceptanceBrokerService } from "$lib/server/application/preview-acceptance-broker";
import { ApplicationPreviewGateReconcilerService } from "$lib/server/application/preview-gate-reconciler";
import { ApplicationPreviewActivationGateService } from "$lib/server/application/preview-activation-gate";
import { ApplicationPreviewActivationDispatchService } from "$lib/server/application/preview-activation-dispatch";
import { ApplicationPreviewAcceptedImageReuseService } from "$lib/server/application/preview-accepted-image-reuse";
import { ApplicationPreviewControlSourceAuthorityService } from "$lib/server/application/preview-control-source-authority";
import { ApplicationPreviewDevSyncCredentialMintService } from "$lib/server/application/preview-dev-sync-credentials";
import { ApplicationPreviewRuntimeBrokerService } from "$lib/server/application/preview-runtime-broker";
import {
  ApplicationPreviewSourcePromotionBrokerService,
  ApplicationPreviewSourcePromotionService,
} from "$lib/server/application/preview-source-promotion";
import {
  HmacPreviewRuntimeCapabilityAdapter,
  HttpPreviewRuntimeUpstreamAdapter,
} from "$lib/server/application/adapters/preview-runtime";
import {
  PostgresPreviewRuntimeBudgetCleanupAdapter,
  PostgresPreviewRuntimeBudgetReservationAdapter,
} from "$lib/server/application/adapters/preview-runtime-budget";
import { HmacPreviewDevSyncLeafIssuerAdapter } from "$lib/server/application/adapters/preview-dev-sync-credentials";
import { GithubAppInstallationTokenAdapter } from "$lib/server/application/adapters/preview-github-app";
import {
  HttpPreviewEnvironmentVerifier,
  TektonPreviewEnvironmentImageBuildAdapter,
  VclusterPreviewInventoryAdapter,
  VclusterPreviewReadinessAdapter,
  VclusterPreviewRuntimeInspectionAdapter,
  VclusterPreviewTeardownAdapter,
} from "$lib/server/application/adapters/preview-environment-acceptance";
import { WorkflowDataPreviewAcceptanceArtifactAdapter } from "$lib/server/application/adapters/preview-acceptance-trust";
import {
  HttpPreviewArtifactTransferAdapter,
  PostgresPreviewControlArtifactStore,
  PreviewControlAcceptanceArtifactAdapter,
  WorkflowDataPreviewArtifactExportAdapter,
} from "$lib/server/application/adapters/preview-control-artifacts";
import { TektonPreviewDevelopmentBuildAdapter } from "$lib/server/application/adapters/preview-development-build";
import { TektonPreviewActivationBuildAdapter } from "$lib/server/application/adapters/preview-activation-build";
import { HttpPreviewActivationBrokerAdapter } from "$lib/server/application/adapters/preview-activation-dispatch";
import {
  HmacPreviewAcceptedImageReceiptAttestationAdapter,
  PostgresPreviewAcceptedImageReceiptStore,
} from "$lib/server/application/adapters/preview-accepted-images";
import { GithubPreviewMergedCommitInspectionAdapter } from "$lib/server/application/adapters/preview-merged-commits";
import {
  GithubPreviewControlSourceAdapter,
  GithubPreviewControlPullRequestAdapter,
  GithubPreviewGateBaseCatalogAdapter,
  GithubPreviewAcceptanceCommitStatusAdapter,
  EnvironmentPreviewLocalControlIdentityAdapter,
  HttpPreviewAcceptanceBrokerAdapter,
  HttpPreviewDevelopmentBuildBrokerAdapter,
  HttpPreviewInfrastructureCandidateBrokerAdapter,
  HttpPreviewSourcePromotionBrokerAdapter,
  VclusterPreviewControlEnvironmentAdapter,
} from "$lib/server/application/adapters/preview-control";
import type {
  PreviewAcceptanceBrokerPort,
  PreviewEnvironmentDesiredStatePort,
  PreviewEnvironmentDeletionOutboxPort,
  PreviewEnvironmentUserLaunchPort,
  PreviewInfrastructureCandidateBrokerPort,
  PreviewActivationDispatchPort,
  VclusterPreviewGatewayPort,
} from "$lib/server/application/ports";
import { ApplicationWorkflowExecutionReadModelService } from "$lib/server/application/workflow-execution-read-model";
import { ApplicationWorkflowCodeCheckpointService } from "$lib/server/application/workflow-code-checkpoints";
import { ApplicationWorkflowCodeVersionService } from "$lib/server/application/workflow-code-versions";
import { ApplicationWorkflowCodeVersionPromotionService } from "$lib/server/application/workflow-code-version-promotion";
import { ApplicationWorkflowTriggerManagementService } from "$lib/server/application/workflow-trigger-management";
import { ApplicationWorkflowTriggerLifecycleService } from "$lib/server/application/workflow-trigger-lifecycle";
import { ApplicationWorkflowDataService } from "$lib/server/application/workflow-data";
import { ApplicationWorkflowPlanService } from "$lib/server/application/workflow-plan";
import { ApplicationGitOpsActivityEventService } from "$lib/server/application/gitops-activity-events";
import { ApplicationGitOpsDeploymentService } from "$lib/server/application/gitops-deployment";
import { ApplicationGitOpsPromotionsService } from "$lib/server/application/gitops-promotions";
import { ApplicationAuthSignInService } from "$lib/server/application/auth-sign-in";
import { ApplicationAuthSessionService } from "$lib/server/application/auth-session";
import { extractExecutionTraceIds } from "$lib/server/otel/clickhouse";
import { costFor, formatCurrency } from "$lib/server/pricing/model-pricing";
import {
  resolveRunDiffPatch,
  RUN_DIFF_KIND,
} from "$lib/server/workflows/run-diff";

export { getEventBusAdapter } from "$lib/server/application/event-bus";

function boundedPreviewRuntimeInteger(
  raw: string | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  const parsed = Number(raw ?? "");
  if (!Number.isSafeInteger(parsed) || parsed < 1) return fallback;
  return Math.max(minimum, Math.min(maximum, parsed));
}

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
  // Event bus + workflow scheduler are selected below (getEventBusAdapter /
  // the workflowScheduler branch) and validated by getApplicationAdapterConfig;
  // both families have a lite member, so no fixed-value guard here.
  const stagedDaprAdapters = [
    [
      "WORKFLOW_DEFINITIONS_STORE_ADAPTER",
      config.workflowDefinitionsStoreAdapter,
    ],
  ].filter(([, adapter]) => adapter === "dapr-postgres-binding");
  if (stagedDaprAdapters.length > 0) {
    throw new Error(
      `Dapr PostgreSQL binding adapters are not wired for: ${stagedDaprAdapters.map(([key]) => key).join(", ")}`,
    );
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
  let browserArtifacts: WorkflowBrowserArtifactStore | undefined;
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
  let workflowExecutions: WorkflowExecutionRepository | undefined;
  let workflowFiles: PostgresWorkflowFileStore | undefined;
  let sandboxInventory: PostgresSandboxInventoryRepository | undefined;
  let artifactStore: ArtifactStore | undefined;
  let workspaceSessions: PostgresWorkspaceSessionStore | undefined;
  let agentRuns: PostgresWorkflowAgentRunStore | undefined;
  let planArtifacts: WorkflowPlanArtifactStore | undefined;
  let traceLineage: PostgresTraceLineageStore | undefined;
  let usageReporting: PostgresUsageReportingRepository | undefined;
  let goalFlow: PostgresGoalFlowReadStore | undefined;
  let sessions: CurrentSessionRepository | undefined;
  let sessionProvisioning: KubernetesSessionProvisioningReader | undefined;
  let sessionEvents:
    | PostgresSessionEventLog
    | ReturnType<typeof createDaprPostgresSessionEventLog>
    | undefined;
  let sessionRuntimeConfigs: DefaultSessionRuntimeConfigReader | undefined;
  let sessionRuntimeEvents: DaprSessionRuntimeEventRaiser | undefined;
  let sessionAgentConfigCommands: SessionAgentConfigCommandAdapter | undefined;
  let sessionTraceLifecycle: LegacyMlflowSessionTraceLifecycle | undefined;
  let sessionGoalStore: PostgresSessionGoalStore | undefined;
  let peerAgentResolver: RegistryPeerAgentResolver | undefined;
  let agentSkillHydration: PostgresAgentSkillHydrationRepository | undefined;
  let sessionEventNotifications:
    | PostgresWorkflowSessionEventNotificationSource
    | undefined;
  let codeCheckpoints: PostgresWorkflowCodeCheckpointStore | undefined;
  let evaluationArtifacts: PostgresEvaluationArtifactStore | undefined;
  let workflowData: ApplicationWorkflowDataService | undefined;
  let agentRuntimeWarmPools: KubernetesAgentRuntimeWarmPoolClient | undefined;
  let agentRuntimeControl: ApplicationAgentRuntimeControlService | undefined;
  let agentBackfill: ApplicationAgentBackfillService | undefined;
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
  let benchmarkRouteOperations:
    | ApplicationBenchmarkRouteOperationsService
    | undefined;
  let evaluationRunLaunch: ApplicationEvaluationRunLaunchService | undefined;
  let evaluationDefinitions: ApplicationEvaluationDefinitionService | undefined;
  let evaluationDatasets: ApplicationEvaluationDatasetService | undefined;
  let evaluationRuns: ApplicationEvaluationRunService | undefined;
  let evaluationRunItems: ApplicationEvaluationRunItemService | undefined;
  let evaluationTemplates: ApplicationEvaluationTemplateService | undefined;
  let environments: ApplicationEnvironmentService | undefined;
  let environmentBuildActivity:
    | ApplicationEnvironmentBuildActivityService
    | undefined;
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
  let benchmarkMlflowEvaluation:
    | ApplicationBenchmarkMlflowEvaluationService
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
  let authSignIn: ApplicationAuthSignInService | undefined;
  let authSession: ApplicationAuthSessionService | undefined;
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
  let scriptCalls: ApplicationScriptCallsService | undefined;
  let daprPostgresScriptCallsStore: DaprPostgresScriptCallsStore | undefined;
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
  let previewRunFeed: ApplicationPreviewRunFeedService | undefined;
  let prPreviews: ApplicationPrPreviewFacadeService | undefined;
  let prPreviewCommands: PrPreviewCommandPort | undefined;
  let previewReadProxy: ApplicationPreviewReadProxyService | undefined;
  let previewReadBroker: ApplicationPreviewReadBrokerService | undefined;
  let previewArchive: ApplicationPreviewArchiveService | undefined;
  let previewAccess: ApplicationPreviewAccessService | undefined;
  let previewLifecycleReaper:
    | ApplicationPreviewLifecycleReaperService
    | undefined;
  let vclusterPreviews: ApplicationVclusterPreviewService | undefined;
  let previewEnvironmentDesiredState:
    | (PreviewEnvironmentDesiredStatePort &
        PreviewEnvironmentDeletionOutboxPort)
    | undefined;
  let localVclusterPreviewGateway: VclusterPreviewGatewayPort | undefined;
  let physicalVclusterPreviewGateway: VclusterPreviewGatewayPort | undefined;
  let vclusterPreviewGateway: VclusterPreviewGatewayPort | undefined;
  let previewEnvironments: PreviewEnvironmentUserLaunchPort | undefined;
  let previewEnvironmentLaunchBroker:
    | ApplicationPreviewEnvironmentLaunchBrokerService
    | undefined;
  let previewEnvironmentLifecycleBroker:
    | ApplicationPreviewEnvironmentLifecycleBrokerService
    | undefined;
  let previewEnvironmentDeletionReconciler:
    | ApplicationPreviewEnvironmentDeletionReconcilerService
    | undefined;
  let previewEnvironmentAcceptance:
    | ApplicationPreviewEnvironmentAcceptanceService
    | undefined;
  let previewAcceptanceTrust:
    | ApplicationPreviewAcceptanceTrustService
    | undefined;
  let previewDevelopmentBuild:
    | ApplicationPreviewDevelopmentBuildService
    | undefined;
  let previewDevelopmentBuildBroker:
    | ApplicationPreviewDevelopmentBuildBrokerService
    | undefined;
  let previewAcceptanceBroker: PreviewAcceptanceBrokerPort | undefined;
  let previewGateReconciler:
    | ApplicationPreviewGateReconcilerService
    | undefined;
  let previewActivationGate:
    | ApplicationPreviewActivationGateService
    | undefined;
  let previewActivationDispatch: PreviewActivationDispatchPort | undefined;
  let previewAcceptedImageReceipts:
    | PostgresPreviewAcceptedImageReceiptStore
    | undefined;
  let previewAcceptedImageReceiptAttestations:
    | HmacPreviewAcceptedImageReceiptAttestationAdapter
    | undefined;
  let previewAcceptedImageReuse:
    | ApplicationPreviewAcceptedImageReuseService
    | undefined;
  let previewGithubReadToken: GithubAppInstallationTokenAdapter | undefined;
  let previewGithubStatusToken: GithubAppInstallationTokenAdapter | undefined;
  let previewGithubSourceWriteToken:
    | GithubAppInstallationTokenAdapter
    | undefined;
  let previewInfrastructureCandidates:
    | PreviewInfrastructureCandidateBrokerPort
    | undefined;
  let previewPrAdoption: ApplicationPreviewPrAdoptionService | undefined;
  let previewControlArtifactStore:
    | PostgresPreviewControlArtifactStore
    | undefined;
  let previewArtifactIngress:
    | ApplicationPreviewArtifactIngressService
    | undefined;
  let previewArtifactTransfer: HttpPreviewArtifactTransferAdapter | undefined;
  let previewLocalControlIdentity:
    | EnvironmentPreviewLocalControlIdentityAdapter
    | undefined;
  let previewControlSourceAuthority:
    | ApplicationPreviewControlSourceAuthorityService
    | undefined;
  let previewDevSyncCredentialMint:
    | ApplicationPreviewDevSyncCredentialMintService
    | undefined;
  let previewRuntimeBroker: ApplicationPreviewRuntimeBrokerService | undefined;
  let previewRuntimeBudgetReservation:
    | PostgresPreviewRuntimeBudgetReservationAdapter
    | undefined;
  let previewRuntimeBudgetCleanup:
    | PostgresPreviewRuntimeBudgetCleanupAdapter
    | undefined;
  let previewSourcePromotion:
    | ApplicationPreviewSourcePromotionService
    | undefined;
  let previewSourcePromotionBroker:
    | ApplicationPreviewSourcePromotionBrokerService
    | undefined;
  let devPreviewSidecar: ApplicationDevPreviewSidecarService | undefined;
  let devPreviewSourceCapture:
    | ApplicationDevPreviewSourceCaptureService
    | undefined;
  let previewSessionContinuation:
    | ApplicationPreviewSessionContinuationService
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
  let gitOpsDeployment: ApplicationGitOpsDeploymentService | undefined;
  let gitOpsPromotions: ApplicationGitOpsPromotionsService | undefined;
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
    (browserArtifacts ??=
      config.workflowBrowserArtifactsStoreAdapter === "dapr-postgres-binding"
        ? new DaprPostgresWorkflowBrowserArtifactStore(
            new PostgresWorkflowBrowserArtifactBlobPayloadStore(getDatabase()),
          )
        : new PostgresWorkflowBrowserArtifactStore(getDatabase()));
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
    (devEnvironments ??= new PostgresDevEnvironmentReadRepository(
      getDatabase(),
    ));
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
    (observabilityTraceAccess ??=
      new ApplicationObservabilityTraceAccessService({
        owners: new ClickHouseTraceOwnerResolver(),
        access: getObservabilityTraces(),
      }));
  const getCapabilityBundles = () =>
    (capabilityBundles ??= new ApplicationCapabilityBundleService(
      new PostgresCapabilityBundleRepository(getDatabase),
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
    (workflowExecutions ??=
      config.workflowExecutionsStoreAdapter === "dapr-postgres-binding" ||
      config.workflowExecutionLogsStoreAdapter === "dapr-postgres-binding"
        ? new DaprPostgresWorkflowExecutionRepository(getDatabase())
        : new PostgresWorkflowExecutionRepository(getDatabase()));
  const getWorkflowFiles = () =>
    (workflowFiles ??= new PostgresWorkflowFileStore(getDatabase()));
  const getSandboxInventory = () =>
    (sandboxInventory ??= new PostgresSandboxInventoryRepository(
      getDatabase(),
    ));
  const getArtifactStore = () =>
    (artifactStore ??=
      config.workflowArtifactsStoreAdapter === "dapr-postgres-binding"
        ? new DaprPostgresArtifactStore()
        : new PostgresArtifactStore(getDatabase()));
  const getWorkspaceSessions = () =>
    (workspaceSessions ??= new PostgresWorkspaceSessionStore(getDatabase()));
  const getAgentRuns = () =>
    (agentRuns ??= new PostgresWorkflowAgentRunStore(getDatabase()));
  const getPlanArtifacts = () =>
    (planArtifacts ??=
      config.workflowArtifactsStoreAdapter === "dapr-postgres-binding"
        ? new DaprPostgresWorkflowPlanArtifactStore()
        : new PostgresWorkflowPlanArtifactStore(getDatabase()));
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
    (sessionEvents ??=
      config.sessionEventsStoreAdapter === "dapr-postgres-binding"
        ? createDaprPostgresSessionEventLog(getDatabase())
        : new PostgresSessionEventLog(getDatabase()));
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
  const getTeamStore = () => new PostgresTeamStore(getDatabase);
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
      goalHarness: new RuntimeSessionGoalHarnessResolver(() =>
        getWorkflowData(),
      ),
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
  const getBenchmarkRouteOperations = () =>
    (benchmarkRouteOperations ??=
      new ApplicationBenchmarkRouteOperationsService(
        new LegacyBenchmarkRouteOperationsAdapter(),
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
  const getEvaluationDefinitions = () =>
    (evaluationDefinitions ??= new ApplicationEvaluationDefinitionService(
      new LegacyEvaluationDefinitionRepository(),
    ));
  const getEvaluationDatasets = () =>
    (evaluationDatasets ??= new ApplicationEvaluationDatasetService(
      new LegacyEvaluationDatasetRepository(),
      new LegacyEvaluationDatasetImportParser(),
    ));
  const getEvaluationRuns = () =>
    (evaluationRuns ??= new ApplicationEvaluationRunService(
      new LegacyEvaluationRunRepository(),
    ));
  const getEvaluationRunItems = () =>
    (evaluationRunItems ??= new ApplicationEvaluationRunItemService(
      new LegacyEvaluationRunItemRepository(),
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
      new LegacyEnvironmentRuntimeResolver(),
    ));
  const getEnvironmentBuildActivity = () =>
    (environmentBuildActivity ??=
      new ApplicationEnvironmentBuildActivityService(
        new LegacyEnvironmentBuildActivityReadAdapter(),
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
  const getAuthSignIn = () =>
    (authSignIn ??= new ApplicationAuthSignInService({
      repository: new PostgresAuthSignInRepository(),
      tokens: new JwtAuthTokenIssuer(),
      ids: new DateAuthIdGenerator(),
    }));
  const getAuthSession = () =>
    (authSession ??= new ApplicationAuthSessionService({
      sessions: new LegacyAuthSessionReader(),
      tokens: new LegacyAuthTokenRefresher(),
      accessTokens: new LegacyAuthAccessTokenVerifier(),
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
      sandboxProvisioner: getSandboxProvisioner(),
      sessions: getSessions(),
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
  const getAgentBackfill = () =>
    (agentBackfill ??= new ApplicationAgentBackfillService(
      new PostgresAgentInlineBackfillRepository(),
    ));
  const getBenchmarkInstanceLifecycle = () =>
    (benchmarkInstanceLifecycle ??=
      new ApplicationBenchmarkInstanceLifecycleService(
        new LegacyBenchmarkInstanceLifecycleAdapter(),
      ));
  const getBenchmarkMlflowEvaluation = () =>
    (benchmarkMlflowEvaluation ??=
      new ApplicationBenchmarkMlflowEvaluationService(
        new PostgresBenchmarkMlflowEvaluationRepository(),
      ));
  const getAgentCatalog = () =>
    (agentCatalog ??= new ApplicationAgentCatalogService({
      agents: new LegacyAgentCatalogRepository(),
      capabilities: new LegacyAgentCompiledCapabilitiesRepository(
        getCapabilityBundles(),
      ),
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
  const getScriptCalls = () =>
    (scriptCalls ??= new ApplicationScriptCallsService({
      workflowData: getWorkflowData(),
      store:
        config.scriptCallsStoreAdapter === "dapr-postgres-binding"
          ? (daprPostgresScriptCallsStore ??=
              new DaprPostgresScriptCallsStore())
          : undefined,
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
  const getPreviewRunFeed = () =>
    (previewRunFeed ??= new ApplicationPreviewRunFeedService({
      feed: new NatsPreviewRunFeed(),
      listPreviews: async () =>
        (await listVclusterPreviews())
          .filter((p) => p.ready)
          // Carry `pool`: a claimed member emits to its POOL-named stream, so the
          // feed must key on pool (its alias `name` stays the display + deep-link).
          .map((p) => ({ name: p.name, url: p.url, pool: p.pool })),
    }));
  const getPreviewEnvironmentDesiredState = () =>
    (previewEnvironmentDesiredState ??=
      new KubernetesPreviewEnvironmentDesiredStateAdapter({
        fetch: previewEnvironmentHubKubeFetch(),
      }));
  const getLocalVclusterPreviewGateway = () =>
    (localVclusterPreviewGateway ??= new LegacyVclusterPreviewGateway());
  const getPhysicalVclusterPreviewGateway = () => {
    if (!isPreviewControlBroker()) {
      throw new Error(
        "physical vCluster desired-state authority is broker-only",
      );
    }
    return (physicalVclusterPreviewGateway ??=
      new DesiredStateVclusterPreviewGateway({
        gateway: getLocalVclusterPreviewGateway(),
        desiredState: getPreviewEnvironmentDesiredState(),
        catalog: new DevPreviewServiceCatalogAdapter(),
      }));
  };
  const getVclusterPreviewGateway = () =>
    (vclusterPreviewGateway ??= isPreviewControlBroker()
      ? getPhysicalVclusterPreviewGateway()
      : new BrokeredVclusterPreviewGateway({
          gateway: getLocalVclusterPreviewGateway(),
        }));
  const getPrPreviewCommands = () => {
    if (prPreviewCommands) return prPreviewCommands;
    const brokerMode =
      (
        env.PREVIEW_CONTROL_BROKER_MODE ??
        process.env.PREVIEW_CONTROL_BROKER_MODE
      )
        ?.trim()
        .toLowerCase() === "true";
    if (!brokerMode) {
      prPreviewCommands = new HttpPrPreviewCommandBrokerAdapter();
      return prPreviewCommands;
    }
    const gateway = getVclusterPreviewGateway();
    prPreviewCommands = new ApplicationPrPreviewService({
      store: new DrizzlePrPreviewRecordStore(),
      environments: {
        launch: (input) => {
          const environments = getPreviewEnvironments();
          if (!(environments instanceof ApplicationPreviewEnvironmentService)) {
            throw new Error(
              "trusted PR preview launch is available only in the physical broker",
            );
          }
          return environments.launch(input);
        },
      },
      readiness: new VclusterPreviewReadinessAdapter(gateway),
      teardown: new VclusterPreviewTeardownAdapter(gateway),
      platformRevisions: new GithubPreviewEnvironmentRevisionResolver({
        credentials: getPreviewGithubReadToken(),
      }),
      pullRequests: new GithubPrPreviewGateway({
        repository: config.prPreviewRepo,
        readCredentials: getPreviewGithubReadToken(),
        commentCredentials: getPreviewGithubSourceWriteToken(),
      }),
      catalog: new DevPreviewServiceCatalogAdapter(),
      devPods: new PreviewBffDevPodGateway(),
      seeder: new HelperPodPrHeadSeeder(getPreviewGithubReadToken()),
      verify: new WorkflowDispatchPrPreviewVerifyRunner(),
      registry: prPreviewRegistryEntries(),
      syncToken: prPreviewSyncToken,
      platformRepository: config.previewPlatformRepository,
      platformRef: config.previewPlatformRef,
      sourceRepository: config.prPreviewRepo,
      verifyEnabled: config.prPreviewVerifyEnabled,
    });
    return prPreviewCommands;
  };
  const getPrPreviews = () =>
    (prPreviews ??= new ApplicationPrPreviewFacadeService(
      getPrPreviewCommands(),
      new DrizzlePrPreviewRecordStore(),
    ));
  // E2/E3 share the SEA preview list. Unlike the feed, targets are NOT
  // filtered on `ready` — a read against a not-yet/no-longer-ready preview
  // degrades in the adapter (short timeout) instead of being invisible.
  const listPreviewReadTargets = async () =>
    (await listVclusterPreviews()).map((p) => {
      const requestId = p.provenance?.requestId;
      const identity =
        typeof requestId === "string" &&
        typeof p.platformRevision === "string" &&
        typeof p.sourceRevision === "string" &&
        typeof p.catalogDigest === "string"
          ? {
              previewName: p.name,
              environmentRequestId: requestId,
              environmentPlatformRevision: p.platformRevision,
              environmentSourceRevision: p.sourceRevision,
              catalogDigest: p.catalogDigest as `sha256:${string}`,
            }
          : null;
      return {
        name: p.name,
        url: p.url,
        pool: p.pool,
        identity,
      };
    });
  const getPreviewReadProxy = () =>
    (previewReadProxy ??= new ApplicationPreviewReadProxyService({
      proxy: new HttpPreviewReadBrokerAdapter(),
      listPreviews: listPreviewReadTargets,
    }));
  const getPreviewArchive = () => {
    if (isPreviewControlBroker()) {
      throw new Error(
        "preview archive coordination is available only in the persistent BFF",
      );
    }
    return (previewArchive ??= new ApplicationPreviewArchiveService({
      proxy: new HttpPreviewReadBrokerAdapter(),
      listPreviews: listPreviewReadTargets,
      files: {
        createFile: (input) => getWorkflowData().createWorkflowFile(input),
        listFilesByScopePrefix: (filter) =>
          getWorkflowData().listWorkflowFilesByScopePrefix(filter),
        getFileContent: (id) => getWorkflowData().getWorkflowFileContent(id),
      },
    }));
  };
  const getPreviewAccess = () =>
    (previewAccess ??= new ApplicationPreviewAccessService({
      previews: getVclusterPreviewGateway(),
      admins: {
        isPlatformAdmin: (userId) => getWorkflowData().isPlatformAdmin(userId),
      },
    }));
  const getPreviewLifecycleReaper = () => {
    if (isPreviewControlBroker()) {
      throw new Error(
        "preview lifecycle reaping is available only in the persistent BFF",
      );
    }
    return (previewLifecycleReaper ??=
      new ApplicationPreviewLifecycleReaperService({
        previews: getVclusterPreviewGateway(),
        archive: getPreviewArchive(),
        batchSize: 3,
        wakeTimeoutMs: 120_000,
        archiveRetryGraceMs: config.previewTtlArchiveGraceMinutes * 60_000,
        fairnessWindowMs: config.previewTtlFairnessWindowSeconds * 1_000,
      }));
  };
  const getVclusterPreviews = () =>
    (vclusterPreviews ??= new ApplicationVclusterPreviewService({
      gateway: getVclusterPreviewGateway(),
      previewRepo: config.prPreviewRepo,
      maxPreviews: config.vclusterPreviewMax,
    }));
  const getPreviewEnvironments = (): PreviewEnvironmentUserLaunchPort => {
    if (previewEnvironments) return previewEnvironments;
    if (!isPreviewControlBroker()) {
      previewEnvironments = new HttpPreviewEnvironmentLaunchBrokerAdapter({
        catalog: new DevPreviewServiceCatalogAdapter(),
      });
      return previewEnvironments;
    }
    previewEnvironments = new ApplicationPreviewEnvironmentService({
      serviceCatalog: new DevPreviewServiceCatalogAdapter(),
      candidatePaths: new ManifestCandidatePathPolicyAdapter(),
      revisions: new GithubPreviewEnvironmentRevisionResolver({
        credentials: getPreviewGithubReadToken(),
      }),
      vcluster: new SeaVclusterPreviewEnvironmentLaunchAdapter({
        gateway: getVclusterPreviewGateway(),
        maxPreviews: config.vclusterPreviewMax,
      }),
      physicalDev:
        new OperatorManagedInfrastructurePreviewEnvironmentLaunchAdapter(),
      defaults: {
        platformRepository: config.previewPlatformRepository,
        platformRef: config.previewPlatformRef,
        sourceRepository: config.previewSourceRepository,
        sourceRef: config.previewSourceRef,
        ttlHours: 24,
      },
      now: () => new Date(),
      requestId: () => globalThis.crypto.randomUUID(),
    });
    return previewEnvironments;
  };
  const getPreviewEnvironmentLaunchBroker = () =>
    (previewEnvironmentLaunchBroker ??=
      new ApplicationPreviewEnvironmentLaunchBrokerService({
        admins: {
          isPlatformAdmin: (userId) =>
            getWorkflowData().isPlatformAdmin(userId),
        },
        environments: getPreviewEnvironments(),
      }));
  const getPreviewEnvironmentLifecycleBroker = () =>
    (previewEnvironmentLifecycleBroker ??=
      new ApplicationPreviewEnvironmentLifecycleBrokerService(
        getPhysicalVclusterPreviewGateway(),
      ));
  const getPreviewEnvironmentDeletionReconciler = () => {
    if (!isPreviewControlBroker()) {
      throw new Error("preview deletion reconciler is broker-only");
    }
    return (previewEnvironmentDeletionReconciler ??=
      new ApplicationPreviewEnvironmentDeletionReconcilerService({
        outbox: getPreviewEnvironmentDesiredState(),
        gateway: getLocalVclusterPreviewGateway(),
        receipts: new LegacyPreviewEnvironmentCleanupReceiptAdapter(),
        runtimeBudgets: getPreviewRuntimeBudgetCleanup(),
        runtimeBudgetRetentionHours: boundedPreviewRuntimeInteger(
          env.PREVIEW_RUNTIME_BUDGET_TOMBSTONE_HOURS ??
            process.env.PREVIEW_RUNTIME_BUDGET_TOMBSTONE_HOURS,
          192,
          169,
          720,
        ),
        runtimeBudgetPruneLimit: boundedPreviewRuntimeInteger(
          env.PREVIEW_RUNTIME_BUDGET_PRUNE_LIMIT ??
            process.env.PREVIEW_RUNTIME_BUDGET_PRUNE_LIMIT,
          100,
          1,
          1_000,
        ),
      }));
  };
  const getPreviewEnvironmentAcceptance = () => {
    if (previewEnvironmentAcceptance) return previewEnvironmentAcceptance;
    const gateway = getVclusterPreviewGateway();
    previewEnvironmentAcceptance =
      new ApplicationPreviewEnvironmentAcceptanceService({
        catalog: new DevPreviewServiceCatalogAdapter(),
        inventory: new VclusterPreviewInventoryAdapter(gateway),
        images: new TektonPreviewEnvironmentImageBuildAdapter(),
        launch: new SeaVclusterPreviewEnvironmentLaunchAdapter({
          gateway,
          maxPreviews: config.vclusterPreviewMax,
        }),
        readiness: new VclusterPreviewReadinessAdapter(gateway),
        runtime: new VclusterPreviewRuntimeInspectionAdapter(gateway),
        verification: new HttpPreviewEnvironmentVerifier({
          capabilities: new HmacPreviewControlCapabilityMintAdapter(),
        }),
        teardown: new VclusterPreviewTeardownAdapter(gateway),
      });
    return previewEnvironmentAcceptance;
  };
  const isPreviewControlBroker = () =>
    (env.PREVIEW_CONTROL_BROKER_MODE ?? process.env.PREVIEW_CONTROL_BROKER_MODE)
      ?.trim()
      .toLowerCase() === "true";
  const getPreviewControlArtifactStore = () =>
    (previewControlArtifactStore ??= new PostgresPreviewControlArtifactStore(
      getWorkflowData,
      getDatabase(),
    ));
  const getPreviewArtifactIngress = () =>
    (previewArtifactIngress ??= new ApplicationPreviewArtifactIngressService({
      authority: getPreviewControlSourceAuthority(),
      catalog: new DevPreviewServiceCatalogAdapter(),
      store: getPreviewControlArtifactStore(),
    }));
  const getPreviewArtifactTransfer = () =>
    (previewArtifactTransfer ??= new HttpPreviewArtifactTransferAdapter(
      new WorkflowDataPreviewArtifactExportAdapter(getWorkflowData),
    ));
  const getPreviewAcceptanceTrust = () =>
    (previewAcceptanceTrust ??= new ApplicationPreviewAcceptanceTrustService({
      artifacts: isPreviewControlBroker()
        ? new PreviewControlAcceptanceArtifactAdapter(
            getPreviewControlArtifactStore(),
          )
        : new WorkflowDataPreviewAcceptanceArtifactAdapter(getWorkflowData),
      catalog: new DevPreviewServiceCatalogAdapter(),
    }));
  const getPreviewLocalControlIdentity = () =>
    (previewLocalControlIdentity ??=
      new EnvironmentPreviewLocalControlIdentityAdapter());
  const getDevPreviewSidecar = () =>
    (devPreviewSidecar ??= new ApplicationDevPreviewSidecarService({
      sidecar: new LegacyDevPreviewSidecarGateway(),
      listEnvironments: (input) => getWorkflowData().listDevEnvironments(input),
    }));
  const getDevPreviewSourceCapture = () =>
    (devPreviewSourceCapture ??= new ApplicationDevPreviewSourceCaptureService({
      capture: new LegacyDevPreviewSourceCaptureAdapter(getWorkflowData),
    }));
  const getPreviewDevelopmentBuild = () =>
    (previewDevelopmentBuild ??= new ApplicationPreviewDevelopmentBuildService({
      capture: getDevPreviewSourceCapture(),
      broker: new HttpPreviewDevelopmentBuildBrokerAdapter({
        artifacts: getPreviewArtifactTransfer(),
      }),
      provisioner: getPreviewEnvironmentProvisioner(),
      catalog: new DevPreviewServiceCatalogAdapter(),
      requestId: () => globalThis.crypto.randomUUID(),
    }));
  const getPreviewControlSourceAuthority = () =>
    (previewControlSourceAuthority ??=
      new ApplicationPreviewControlSourceAuthorityService({
        environments: new VclusterPreviewControlEnvironmentAdapter(
          getVclusterPreviewGateway(),
        ),
        admins: {
          isPlatformAdmin: (userId) =>
            getWorkflowData().isPlatformAdmin(userId),
        },
        catalog: new DevPreviewServiceCatalogAdapter(),
        expectedPlatformRepository: config.previewPlatformRepository,
        expectedSourceRepository: config.previewSourceRepository,
      }));
  const getPreviewDevSyncCredentialMint = () => {
    if (!isPreviewControlBroker()) {
      throw new Error(
        "preview dev-sync credential mint is available only in broker mode",
      );
    }
    return (previewDevSyncCredentialMint ??=
      new ApplicationPreviewDevSyncCredentialMintService({
        authority: getPreviewControlSourceAuthority(),
        catalog: new DevPreviewServiceCatalogAdapter(),
        issuer: new HmacPreviewDevSyncLeafIssuerAdapter(),
      }));
  };
  const getPreviewReadBroker = () =>
    (previewReadBroker ??= new ApplicationPreviewReadBrokerService({
      previews: getVclusterPreviewGateway(),
      authority: getPreviewControlSourceAuthority(),
      capabilities: new HmacPreviewControlCapabilityMintAdapter(),
      transport: new HttpPreviewCapabilityReadTransportAdapter(),
    }));
  const getPreviewRuntimeBudgetReservation = () =>
    (previewRuntimeBudgetReservation ??=
      new PostgresPreviewRuntimeBudgetReservationAdapter(getDatabase()));
  const getPreviewRuntimeBudgetCleanup = () =>
    (previewRuntimeBudgetCleanup ??=
      new PostgresPreviewRuntimeBudgetCleanupAdapter(getDatabase()));
  const getPreviewRuntimeBroker = () => {
    const minuteTokenBudget = boundedPreviewRuntimeInteger(
      env.PREVIEW_RUNTIME_BUDGET_RESERVED_TOKENS_PER_MINUTE ??
        process.env.PREVIEW_RUNTIME_BUDGET_RESERVED_TOKENS_PER_MINUTE,
      600_000,
      128,
      2_000_000,
    );
    const totalTokenBudget = boundedPreviewRuntimeInteger(
      env.PREVIEW_RUNTIME_BUDGET_TOTAL_RESERVED_TOKENS ??
        process.env.PREVIEW_RUNTIME_BUDGET_TOTAL_RESERVED_TOKENS,
      8_000_000,
      128,
      100_000_000,
    );
    const maxCompletionTokens = Math.min(
      boundedPreviewRuntimeInteger(
        env.PREVIEW_RUNTIME_MAX_COMPLETION_TOKENS ??
          process.env.PREVIEW_RUNTIME_MAX_COMPLETION_TOKENS,
        4_096,
        128,
        32_768,
      ),
      minuteTokenBudget,
      totalTokenBudget,
    );
    return (previewRuntimeBroker ??= new ApplicationPreviewRuntimeBrokerService(
      {
        authority: getPreviewControlSourceAuthority(),
        capabilities: new HmacPreviewRuntimeCapabilityAdapter(),
        upstream: new HttpPreviewRuntimeUpstreamAdapter(),
        budget: getPreviewRuntimeBudgetReservation(),
        budgetLimits: {
          requestsPerMinute: boundedPreviewRuntimeInteger(
            env.PREVIEW_RUNTIME_BUDGET_REQUESTS_PER_MINUTE ??
              process.env.PREVIEW_RUNTIME_BUDGET_REQUESTS_PER_MINUTE,
            60,
            1,
            600,
          ),
          reservedTokensPerMinute: minuteTokenBudget,
          totalRequests: boundedPreviewRuntimeInteger(
            env.PREVIEW_RUNTIME_BUDGET_TOTAL_REQUESTS ??
              process.env.PREVIEW_RUNTIME_BUDGET_TOTAL_REQUESTS,
            2_000,
            1,
            100_000,
          ),
          totalReservedTokens: totalTokenBudget,
        },
        requestLimits: {
          maxPayloadBytes: boundedPreviewRuntimeInteger(
            env.PREVIEW_RUNTIME_MAX_PAYLOAD_BYTES ??
              process.env.PREVIEW_RUNTIME_MAX_PAYLOAD_BYTES,
            524_288,
            16_384,
            2_097_152,
          ),
          maxMessages: boundedPreviewRuntimeInteger(
            env.PREVIEW_RUNTIME_MAX_MESSAGES ??
              process.env.PREVIEW_RUNTIME_MAX_MESSAGES,
            128,
            1,
            256,
          ),
          maxContentBytes: boundedPreviewRuntimeInteger(
            env.PREVIEW_RUNTIME_MAX_CONTENT_BYTES ??
              process.env.PREVIEW_RUNTIME_MAX_CONTENT_BYTES,
            65_536,
            1_024,
            262_144,
          ),
          maxTools: boundedPreviewRuntimeInteger(
            env.PREVIEW_RUNTIME_MAX_TOOLS ??
              process.env.PREVIEW_RUNTIME_MAX_TOOLS,
            64,
            1,
            128,
          ),
          maxToolBytes: boundedPreviewRuntimeInteger(
            env.PREVIEW_RUNTIME_MAX_TOOL_BYTES ??
              process.env.PREVIEW_RUNTIME_MAX_TOOL_BYTES,
            65_536,
            1_024,
            262_144,
          ),
          maxCompletionTokens,
          defaultCompletionTokens: Math.min(
            boundedPreviewRuntimeInteger(
              env.PREVIEW_RUNTIME_DEFAULT_COMPLETION_TOKENS ??
                process.env.PREVIEW_RUNTIME_DEFAULT_COMPLETION_TOKENS,
              2_048,
              1,
              32_768,
            ),
            maxCompletionTokens,
          ),
        },
        allowedModels: (
          env.PREVIEW_RUNTIME_ALLOWED_MODELS ??
          process.env.PREVIEW_RUNTIME_ALLOWED_MODELS ??
          ""
        )
          .split(",")
          .map((model) => model.trim())
          .filter(Boolean),
        maxConcurrency: boundedPreviewRuntimeInteger(
          env.PREVIEW_RUNTIME_MAX_CONCURRENCY ??
            process.env.PREVIEW_RUNTIME_MAX_CONCURRENCY,
          8,
          1,
          64,
        ),
        audit: (record) =>
          console.info(`[preview-runtime] ${JSON.stringify(record)}`),
      },
    ));
  };
  const previewGithubRepositories = () =>
    [
      ...new Set([
        config.previewSourceRepository,
        config.previewPlatformRepository,
      ]),
    ]
      .map((repository) => repository.split("/").at(-1) ?? "")
      .filter(Boolean);
  const previewGithubSourceRepository = () => [
    config.previewSourceRepository.split("/").at(-1) ?? "",
  ];
  const getPreviewGithubReadToken = () =>
    (previewGithubReadToken ??= new GithubAppInstallationTokenAdapter({
      repositories: previewGithubRepositories(),
      permissions: {
        contents: "read",
        pull_requests: "read",
      },
    }));
  const getPreviewGithubStatusToken = () =>
    (previewGithubStatusToken ??= new GithubAppInstallationTokenAdapter({
      repositories: previewGithubSourceRepository(),
      permissions: {
        statuses: "write",
      },
    }));
  const getPreviewGithubSourceWriteToken = () =>
    (previewGithubSourceWriteToken ??= new GithubAppInstallationTokenAdapter({
      repositories: previewGithubSourceRepository(),
      permissions: { contents: "write", pull_requests: "write" },
    }));
  const getPreviewAcceptedImageReceiptAttestations = () =>
    (previewAcceptedImageReceiptAttestations ??=
      new HmacPreviewAcceptedImageReceiptAttestationAdapter());
  const getPreviewAcceptedImageReceipts = () =>
    (previewAcceptedImageReceipts ??=
      new PostgresPreviewAcceptedImageReceiptStore(
        getDatabase(),
        getPreviewAcceptedImageReceiptAttestations(),
      ));
  const getPreviewAcceptedImageReuse = () => {
    if (!isPreviewControlBroker()) {
      throw new Error(
        "preview accepted-image reuse is available only in broker mode",
      );
    }
    return (previewAcceptedImageReuse ??=
      new ApplicationPreviewAcceptedImageReuseService({
        merges: new GithubPreviewMergedCommitInspectionAdapter({
          credentials: getPreviewGithubReadToken(),
          baseRef: config.previewSourceRef,
        }),
        receipts: getPreviewAcceptedImageReceipts(),
        attestations: getPreviewAcceptedImageReceiptAttestations(),
        catalog: new DevPreviewServiceCatalogAdapter(),
        sourceRepository: config.previewSourceRepository,
      }));
  };
  const getPreviewGateReconciler = () =>
    (previewGateReconciler ??= new ApplicationPreviewGateReconcilerService({
      pullRequests: new GithubPreviewControlPullRequestAdapter({
        credentials: getPreviewGithubReadToken(),
      }),
      catalog: new DevPreviewServiceCatalogAdapter(),
      baseCatalog: new GithubPreviewGateBaseCatalogAdapter({
        credentials: getPreviewGithubReadToken(),
      }),
      receipts: getPreviewAcceptedImageReceipts(),
      receiptAttestations: getPreviewAcceptedImageReceiptAttestations(),
      statuses: new GithubPreviewAcceptanceCommitStatusAdapter({
        credentials: getPreviewGithubStatusToken(),
      }),
    }));
  const getPreviewActivationGate = () => {
    if (!isPreviewControlBroker()) {
      throw new Error(
        "preview activation gate is available only in broker mode",
      );
    }
    return (previewActivationGate ??=
      new ApplicationPreviewActivationGateService({
        pullRequests: new GithubPreviewControlPullRequestAdapter({
          credentials: getPreviewGithubReadToken(),
        }),
        catalog: new DevPreviewServiceCatalogAdapter(),
        builds: new TektonPreviewActivationBuildAdapter(),
        statuses: new GithubPreviewAcceptanceCommitStatusAdapter({
          credentials: getPreviewGithubStatusToken(),
        }),
        receipts: getPreviewAcceptedImageReceipts(),
        receiptAttestations: getPreviewAcceptedImageReceiptAttestations(),
        gate: getPreviewGateReconciler(),
        sourceRepository: config.previewSourceRepository,
      }));
  };
  const getPreviewActivationDispatch = () =>
    (previewActivationDispatch ??= new ApplicationPreviewActivationDispatchService({
      broker: new HttpPreviewActivationBrokerAdapter(),
      catalog: new DevPreviewServiceCatalogAdapter(),
      sourceRepository: config.previewSourceRepository,
    }));
  const getPreviewDevelopmentBuildBroker = () =>
    (previewDevelopmentBuildBroker ??=
      new ApplicationPreviewDevelopmentBuildBrokerService({
        authority: getPreviewControlSourceAuthority(),
        trust: getPreviewAcceptanceTrust(),
        promotions: new HelperPodSourceBundlePromotionRunner({
          githubToken: () => getPreviewGithubSourceWriteToken().token(),
          requireExplicitGithubToken: true,
          helperSuffix: "preview-development-materialize",
        }),
        git: new GithubPreviewControlSourceAdapter({
          credentials: getPreviewGithubReadToken(),
        }),
        images: new TektonPreviewDevelopmentBuildAdapter(),
        catalog: new DevPreviewServiceCatalogAdapter(),
        sourceRepository: config.previewSourceRepository,
        baseBranch: config.previewSourceRef,
      }));
  const getPreviewSourcePromotionBroker = () =>
    (previewSourcePromotionBroker ??=
      new ApplicationPreviewSourcePromotionBrokerService({
        authority: getPreviewControlSourceAuthority(),
        trust: getPreviewAcceptanceTrust(),
        promotions: new HelperPodSourceBundlePromotionRunner({
          githubToken: () => getPreviewGithubSourceWriteToken().token(),
          requireExplicitGithubToken: true,
          helperSuffix: "preview-source-promotion",
        }),
        git: new GithubPreviewControlSourceAdapter({
          credentials: getPreviewGithubReadToken(),
        }),
        pullRequests: new GithubPreviewControlPullRequestAdapter({
          credentials: getPreviewGithubReadToken(),
        }),
        catalog: new DevPreviewServiceCatalogAdapter(),
        sourceRepository: config.previewSourceRepository,
        baseBranch: config.previewSourceRef,
      }));
  const getPreviewSourcePromotion = () =>
    (previewSourcePromotion ??= new ApplicationPreviewSourcePromotionService({
      identity: getPreviewLocalControlIdentity(),
      artifacts: getPreviewArtifactTransfer(),
      broker: new HttpPreviewSourcePromotionBrokerAdapter({
        sourceRepository: config.previewSourceRepository,
      }),
    }));
  const getPreviewSessionContinuation = () =>
    (previewSessionContinuation ??=
      new ApplicationPreviewSessionContinuationService({
        workflowData: getWorkflowData(),
        identity: getPreviewLocalControlIdentity(),
        capture: getDevPreviewSourceCapture(),
        promotion: getPreviewSourcePromotion(),
        acceptance: getPreviewAcceptanceBroker(),
      }));
  const getPreviewAcceptanceBroker = () => {
    if (previewAcceptanceBroker) return previewAcceptanceBroker;
    const brokerMode =
      (
        env.PREVIEW_CONTROL_BROKER_MODE ??
        process.env.PREVIEW_CONTROL_BROKER_MODE
      )
        ?.trim()
        .toLowerCase() === "true";
    previewAcceptanceBroker = brokerMode
      ? new ApplicationPreviewAcceptanceBrokerService({
          authority: getPreviewControlSourceAuthority(),
          pullRequests: new GithubPreviewControlPullRequestAdapter({
            credentials: getPreviewGithubReadToken(),
          }),
          statuses: new GithubPreviewAcceptanceCommitStatusAdapter({
            credentials: getPreviewGithubStatusToken(),
          }),
          receipts: getPreviewAcceptedImageReceipts(),
          receiptAttestations: getPreviewAcceptedImageReceiptAttestations(),
          gate: getPreviewGateReconciler(),
          catalog: new DevPreviewServiceCatalogAdapter(),
          acceptance: getPreviewEnvironmentAcceptance(),
          sourceRepository: config.previewSourceRepository,
        })
      : new HttpPreviewAcceptanceBrokerAdapter({
          catalog: new DevPreviewServiceCatalogAdapter(),
        });
    return previewAcceptanceBroker;
  };
  const getPreviewInfrastructureCandidates =
    (): PreviewInfrastructureCandidateBrokerPort => {
      if (previewInfrastructureCandidates)
        return previewInfrastructureCandidates;
      const brokerMode =
        (
          env.PREVIEW_CONTROL_BROKER_MODE ??
          process.env.PREVIEW_CONTROL_BROKER_MODE
        )
          ?.trim()
          .toLowerCase() === "true";
      previewInfrastructureCandidates = brokerMode
        ? new ApplicationPreviewInfrastructureCandidateBrokerService({
            admins: {
              isPlatformAdmin: (userId) =>
                getWorkflowData().isPlatformAdmin(userId),
            },
            pullRequests: new GithubPreviewControlPullRequestAdapter({
              credentials: getPreviewGithubReadToken(),
            }),
            paths: new ManifestCandidatePathPolicyAdapter(),
            environments: {
              launch: (input) =>
                getPreviewEnvironments().launchForUser({
                  name: input.name,
                  userId: input.userId,
                  profile: input.profile,
                  lane: input.lane,
                  capabilities: input.capabilities,
                  platformRevision: input.platformRevision,
                  sourceRef: input.sourceRef,
                  candidatePaths: input.candidatePaths,
                  ttlHours: input.ttlHours,
                  lifecycle: input.lifecycle,
                  allocation: { kind: "cold" },
                  provenance: {
                    parentEnvironmentId: input.parentEnvironmentId,
                  },
                }),
            },
            platformRepository: config.previewPlatformRepository,
            sourceRef: config.previewSourceRef,
          })
        : new HttpPreviewInfrastructureCandidateBrokerAdapter({
            platformRepository: config.previewPlatformRepository,
          });
      return previewInfrastructureCandidates;
    };
  const getPreviewPrAdoption = () =>
    (previewPrAdoption ??= new ApplicationPreviewPrAdoptionService({
      provisioner: new SandboxExecutionPreviewEnvironmentProvisioner(),
      catalog: new DevPreviewServiceCatalogAdapter(),
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
        runner: new HelperPodSourceBundlePromotionRunner({
          // D2: auto-label Promote-opened PRs `preview` (flag, default off).
          addPreviewLabel: config.promoteAutoPreviewLabel,
        }),
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
  const getGitOpsDeployment = () =>
    (gitOpsDeployment ??= new ApplicationGitOpsDeploymentService({
      metadata: new LegacyDeploymentMetadataGateway(),
    }));
  const getGitOpsPromotions = () =>
    (gitOpsPromotions ??= new ApplicationGitOpsPromotionsService({
      promotions: new LegacyPromotionStateGateway(),
    }));
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
      workflowEphemeralAgents: new PostgresWorkflowEphemeralAgentStore(),
      agentRuntimeSync: new AgentRuntimeRegistrySyncAdapter(),
      devSessionWorkflows: getWorkflowDefinitions(),
    }));
  const getSessionAgentConfig = () =>
    (sessionAgentConfig ??= new ApplicationSessionAgentConfigService({
      patches: getWorkflowData(),
    }));
  const workflowScheduler =
    config.workflowSchedulerAdapter === "lite-stub"
      ? new LiteStubWorkflowScheduler()
      : new DaprWorkflowScheduler();
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
    get teamStore() {
      return getTeamStore();
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
    get benchmarkRouteOperations() {
      return getBenchmarkRouteOperations();
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
    get benchmarkMlflowEvaluation() {
      return getBenchmarkMlflowEvaluation();
    },
    get evaluationRunLaunch() {
      return getEvaluationRunLaunch();
    },
    get evaluationDefinitions() {
      return getEvaluationDefinitions();
    },
    get evaluationDatasets() {
      return getEvaluationDatasets();
    },
    get evaluationRuns() {
      return getEvaluationRuns();
    },
    get evaluationRunItems() {
      return getEvaluationRunItems();
    },
    get evaluationTemplates() {
      return getEvaluationTemplates();
    },
    get environments() {
      return getEnvironments();
    },
    get environmentBuildActivity() {
      return getEnvironmentBuildActivity();
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
    get authSignIn() {
      return getAuthSignIn();
    },
    get authSession() {
      return getAuthSession();
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
    get agentBackfill() {
      return getAgentBackfill();
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
    get scriptCalls() {
      return getScriptCalls();
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
    get previewRunFeed() {
      return getPreviewRunFeed();
    },
    get prPreviews() {
      return getPrPreviews();
    },
    get previewReadProxy() {
      return getPreviewReadProxy();
    },
    get previewReadBroker() {
      return getPreviewReadBroker();
    },
    get previewArchive() {
      return getPreviewArchive();
    },
    get previewAccess() {
      return getPreviewAccess();
    },
    get previewLifecycleReaper() {
      return getPreviewLifecycleReaper();
    },
    get vclusterPreviews() {
      return getVclusterPreviews();
    },
    get previewEnvironments() {
      return getPreviewEnvironments();
    },
    get previewEnvironmentLaunchBroker() {
      return getPreviewEnvironmentLaunchBroker();
    },
    get previewEnvironmentLifecycleBroker() {
      return getPreviewEnvironmentLifecycleBroker();
    },
    get previewEnvironmentDeletionReconciler() {
      return getPreviewEnvironmentDeletionReconciler();
    },
    get previewEnvironmentAcceptance() {
      return getPreviewEnvironmentAcceptance();
    },
    get previewAcceptanceTrust() {
      return getPreviewAcceptanceTrust();
    },
    get previewLocalControlIdentity() {
      return getPreviewLocalControlIdentity();
    },
    get previewDevelopmentBuild() {
      return getPreviewDevelopmentBuild();
    },
    get previewControlSourceAuthority() {
      return getPreviewControlSourceAuthority();
    },
    get previewDevSyncCredentialMint() {
      return getPreviewDevSyncCredentialMint();
    },
    get previewRuntimeBroker() {
      return getPreviewRuntimeBroker();
    },
    get previewDevelopmentBuildBroker() {
      return getPreviewDevelopmentBuildBroker();
    },
    get previewSourcePromotion() {
      return getPreviewSourcePromotion();
    },
    get previewSourcePromotionBroker() {
      return getPreviewSourcePromotionBroker();
    },
    get previewSessionContinuation() {
      return getPreviewSessionContinuation();
    },
    get previewAcceptanceBroker() {
      return getPreviewAcceptanceBroker();
    },
    get previewActivationGate() {
      return getPreviewActivationGate();
    },
    get previewActivationDispatch() {
      return getPreviewActivationDispatch();
    },
    get previewAcceptedImageReuse() {
      return getPreviewAcceptedImageReuse();
    },
    get previewInfrastructureCandidates() {
      return getPreviewInfrastructureCandidates();
    },
    get previewPrAdoption() {
      return getPreviewPrAdoption();
    },
    get previewArtifactIngress() {
      return getPreviewArtifactIngress();
    },
    get devPreviewSidecar() {
      return getDevPreviewSidecar();
    },
    get devPreviewSourceCapture() {
      return getDevPreviewSourceCapture();
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
    get gitOpsDeployment() {
      return getGitOpsDeployment();
    },
    get gitOpsPromotions() {
      return getGitOpsPromotions();
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
