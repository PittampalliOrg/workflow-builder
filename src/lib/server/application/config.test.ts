import { describe, expect, it } from "vitest";
import { getApplicationAdapterConfig } from "$lib/server/application/config";

describe("application adapter config", () => {
	it("uses current production adapters by default", () => {
		expect(getApplicationAdapterConfig({})).toEqual({
			appProfile: "full",
			persistenceAdapter: "postgres",
			eventBusAdapter: "dapr-pubsub",
			artifactStoreAdapter: "postgres-metadata-object-data",
			workflowSchedulerAdapter: "dapr-workflow",
			previewProvisionerAdapter: "sandbox-execution-api",
			scriptCallsStoreAdapter: "postgres",
			workflowExecutionsStoreAdapter: "postgres",
			workflowExecutionLogsStoreAdapter: "postgres",
			workflowArtifactsStoreAdapter: "postgres",
			workflowBrowserArtifactsStoreAdapter: "postgres",
			sessionEventsStoreAdapter: "postgres",
			workflowDefinitionsStoreAdapter: "postgres",
			previewRunFeedEnabled: false,
			prPreviewsEnabled: false,
			prPreviewRepo: "PittampalliOrg/workflow-builder",
			vclusterPreviewMax: 6,
			previewPlatformRepository: "PittampalliOrg/stacks",
			previewPlatformRef: "main",
			previewSourceRepository: "PittampalliOrg/workflow-builder",
			previewSourceRef: "main",
			prPreviewVerifyEnabled: false,
			promoteAutoPreviewLabel: false,
			previewReadProxyEnabled: false,
			previewArchiveOnTeardownEnabled: false,
			previewTtlArchiveGraceMinutes: 60,
			previewTtlFairnessWindowSeconds: 60,
		});
	});

	it("enables the D1/D2 pr-preview flags only when truthy", () => {
		expect(getApplicationAdapterConfig({}).prPreviewsEnabled).toBe(false);
		expect(
			getApplicationAdapterConfig({ PR_PREVIEWS_ENABLED: "true" })
				.prPreviewsEnabled,
		).toBe(true);
		expect(
			getApplicationAdapterConfig({ PR_PREVIEW_VERIFY_ENABLED: "1" })
				.prPreviewVerifyEnabled,
		).toBe(true);
		expect(
			getApplicationAdapterConfig({ PROMOTE_AUTO_PREVIEW_LABEL: "on" })
				.promoteAutoPreviewLabel,
		).toBe(true);
	});

	it("enables the preview read proxy and archive-on-teardown only when flagged", () => {
		expect(getApplicationAdapterConfig({}).previewReadProxyEnabled).toBe(
			false,
		);
		expect(
			getApplicationAdapterConfig({}).previewArchiveOnTeardownEnabled,
		).toBe(false);
		expect(
			getApplicationAdapterConfig({ PREVIEW_READ_PROXY_ENABLED: "1" })
				.previewReadProxyEnabled,
		).toBe(true);
		expect(
			getApplicationAdapterConfig({ PREVIEW_ARCHIVE_ON_TEARDOWN: "true" })
				.previewArchiveOnTeardownEnabled,
		).toBe(true);
		expect(
			getApplicationAdapterConfig({ PREVIEW_ARCHIVE_ON_TEARDOWN: "off" })
				.previewArchiveOnTeardownEnabled,
		).toBe(false);
	});

	it("enables the preview run feed only when the flag is truthy", () => {
		expect(getApplicationAdapterConfig({}).previewRunFeedEnabled).toBe(
			false,
		);
		expect(
			getApplicationAdapterConfig({ PREVIEW_RUN_FEED_ENABLED: "true" })
				.previewRunFeedEnabled,
		).toBe(true);
		expect(
			getApplicationAdapterConfig({ PREVIEW_RUN_FEED_ENABLED: "off" })
				.previewRunFeedEnabled,
		).toBe(false);
	});

	it("bounds TTL archive grace and fairness configuration", () => {
		expect(
			getApplicationAdapterConfig({
				PREVIEW_TTL_ARCHIVE_GRACE_MINUTES: "120",
				PREVIEW_TTL_FAIRNESS_WINDOW_SECONDS: "15",
			}),
		).toMatchObject({
			previewTtlArchiveGraceMinutes: 120,
			previewTtlFairnessWindowSeconds: 15,
		});
		expect(
			getApplicationAdapterConfig({
				PREVIEW_TTL_ARCHIVE_GRACE_MINUTES: "99999",
				PREVIEW_TTL_FAIRNESS_WINDOW_SECONDS: "0",
			}),
		).toMatchObject({
			previewTtlArchiveGraceMinutes: 1_440,
			previewTtlFairnessWindowSeconds: 1,
		});
	});

	it("accepts kro as an optional preview provisioner adapter", () => {
		expect(
			getApplicationAdapterConfig({
				PREVIEW_PROVISIONER_ADAPTER: "kro",
			}).previewProvisionerAdapter,
		).toBe("kro");
	});

	it("rejects unsupported adapters before runtime wiring is selected", () => {
		expect(() =>
			getApplicationAdapterConfig({
				PERSISTENCE_ADAPTER: "sqlite",
			}),
		).toThrow("Unsupported PERSISTENCE_ADAPTER='sqlite'");
	});

	it("flips the Dapr-coupled families to in-process members in the lite profile", () => {
		expect(getApplicationAdapterConfig({ APP_PROFILE: "lite" })).toEqual({
			appProfile: "lite",
			persistenceAdapter: "postgres",
			eventBusAdapter: "in-process",
			artifactStoreAdapter: "postgres-metadata-object-data",
			workflowSchedulerAdapter: "lite-stub",
			previewProvisionerAdapter: "sandbox-execution-api",
			scriptCallsStoreAdapter: "postgres",
			workflowExecutionsStoreAdapter: "postgres",
			workflowExecutionLogsStoreAdapter: "postgres",
			workflowArtifactsStoreAdapter: "postgres",
			workflowBrowserArtifactsStoreAdapter: "postgres",
			sessionEventsStoreAdapter: "postgres",
			workflowDefinitionsStoreAdapter: "postgres",
			previewRunFeedEnabled: false,
			prPreviewsEnabled: false,
			prPreviewRepo: "PittampalliOrg/workflow-builder",
			vclusterPreviewMax: 6,
			previewPlatformRepository: "PittampalliOrg/stacks",
			previewPlatformRef: "main",
			previewSourceRepository: "PittampalliOrg/workflow-builder",
			previewSourceRef: "main",
			prPreviewVerifyEnabled: false,
			promoteAutoPreviewLabel: false,
			previewReadProxyEnabled: false,
			previewArchiveOnTeardownEnabled: false,
			previewTtlArchiveGraceMinutes: 60,
			previewTtlFairnessWindowSeconds: 60,
		});
	});

	it("configures repository refs that are resolved before preview launch", () => {
		const config = getApplicationAdapterConfig({
			PREVIEW_PLATFORM_REPOSITORY: "Example/platform",
			PREVIEW_PLATFORM_REF: "refs/pull/7/merge",
			PREVIEW_SOURCE_REPOSITORY: "Example/app",
			PREVIEW_SOURCE_REF: "feature/x",
		});
		expect(config.previewPlatformRepository).toBe("Example/platform");
		expect(config.previewPlatformRef).toBe("refs/pull/7/merge");
		expect(config.previewSourceRepository).toBe("Example/app");
		expect(config.previewSourceRef).toBe("feature/x");
	});

	it("lets an explicit adapter env override the lite-profile default", () => {
		const config = getApplicationAdapterConfig({
			APP_PROFILE: "lite",
			EVENT_BUS_ADAPTER: "dapr-pubsub",
			WORKFLOW_SCHEDULER_ADAPTER: "dapr-workflow",
		});
		expect(config.eventBusAdapter).toBe("dapr-pubsub");
		expect(config.workflowSchedulerAdapter).toBe("dapr-workflow");
	});

	it("still throws on unknown values in the lite profile", () => {
		expect(() =>
			getApplicationAdapterConfig({
				APP_PROFILE: "lite",
				EVENT_BUS_ADAPTER: "bogus",
			}),
		).toThrow("Unsupported EVENT_BUS_ADAPTER='bogus'");
	});

	it("rejects an unknown APP_PROFILE", () => {
		expect(() =>
			getApplicationAdapterConfig({ APP_PROFILE: "prod" }),
		).toThrow("Unsupported APP_PROFILE='prod'");
	});

	it("accepts the new in-process / lite-stub members under the full profile too", () => {
		const config = getApplicationAdapterConfig({
			EVENT_BUS_ADAPTER: "in-process",
			WORKFLOW_SCHEDULER_ADAPTER: "lite-stub",
		});
		expect(config.appProfile).toBe("full");
		expect(config.eventBusAdapter).toBe("in-process");
		expect(config.workflowSchedulerAdapter).toBe("lite-stub");
	});

	it("selects the Dapr PostgreSQL binding for the bounded script-call store", () => {
		expect(
			getApplicationAdapterConfig({
				SCRIPT_CALLS_STORE_ADAPTER: "dapr-postgres-binding",
			}).scriptCallsStoreAdapter,
		).toBe("dapr-postgres-binding");
	});

	it("rejects unsupported script-call store adapters", () => {
		expect(() =>
			getApplicationAdapterConfig({
				SCRIPT_CALLS_STORE_ADAPTER: "raw-sql",
			}),
		).toThrow("Unsupported SCRIPT_CALLS_STORE_ADAPTER='raw-sql'");
	});

	it("defaults staged product-data store adapters to postgres", () => {
		const config = getApplicationAdapterConfig({});
		expect(config.workflowExecutionsStoreAdapter).toBe("postgres");
		expect(config.workflowExecutionLogsStoreAdapter).toBe("postgres");
		expect(config.workflowArtifactsStoreAdapter).toBe("postgres");
		expect(config.workflowBrowserArtifactsStoreAdapter).toBe("postgres");
		expect(config.sessionEventsStoreAdapter).toBe("postgres");
		expect(config.workflowDefinitionsStoreAdapter).toBe("postgres");
	});

	it("selects the Dapr PostgreSQL binding for staged product-data store adapters", () => {
		const config = getApplicationAdapterConfig({
			WORKFLOW_EXECUTIONS_STORE_ADAPTER: "dapr-postgres-binding",
			WORKFLOW_EXECUTION_LOGS_STORE_ADAPTER: "dapr-postgres-binding",
			WORKFLOW_ARTIFACTS_STORE_ADAPTER: "dapr-postgres-binding",
			WORKFLOW_BROWSER_ARTIFACTS_STORE_ADAPTER: "dapr-postgres-binding",
			SESSION_EVENTS_STORE_ADAPTER: "dapr-postgres-binding",
			WORKFLOW_DEFINITIONS_STORE_ADAPTER: "dapr-postgres-binding",
		});
		expect(config.workflowExecutionsStoreAdapter).toBe(
			"dapr-postgres-binding",
		);
		expect(config.workflowExecutionLogsStoreAdapter).toBe(
			"dapr-postgres-binding",
		);
		expect(config.workflowArtifactsStoreAdapter).toBe(
			"dapr-postgres-binding",
		);
		expect(config.workflowBrowserArtifactsStoreAdapter).toBe(
			"dapr-postgres-binding",
		);
		expect(config.sessionEventsStoreAdapter).toBe("dapr-postgres-binding");
		expect(config.workflowDefinitionsStoreAdapter).toBe(
			"dapr-postgres-binding",
		);
	});

	it("rejects unsupported staged product-data store adapters", () => {
		expect(() =>
			getApplicationAdapterConfig({
				WORKFLOW_EXECUTIONS_STORE_ADAPTER: "raw-sql",
			}),
		).toThrow("Unsupported WORKFLOW_EXECUTIONS_STORE_ADAPTER='raw-sql'");
	});
});
