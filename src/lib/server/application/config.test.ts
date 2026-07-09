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
			previewRunFeedEnabled: false,
			prPreviewsEnabled: false,
			prPreviewRepo: "PittampalliOrg/workflow-builder",
			vclusterPreviewMax: 6,
			prPreviewVerifyEnabled: false,
			promoteAutoPreviewLabel: false,
			previewReadProxyEnabled: false,
			previewArchiveOnTeardownEnabled: false,
		});
	});

	it("enables the D1/D2 pr-preview flags only when truthy", () => {
		expect(getApplicationAdapterConfig({}).prPreviewsEnabled).toBe(false);
		expect(
			getApplicationAdapterConfig({ PR_PREVIEWS_ENABLED: "true" }).prPreviewsEnabled,
		).toBe(true);
		expect(
			getApplicationAdapterConfig({ PR_PREVIEW_VERIFY_ENABLED: "1" }).prPreviewVerifyEnabled,
		).toBe(true);
		expect(
			getApplicationAdapterConfig({ PROMOTE_AUTO_PREVIEW_LABEL: "on" })
				.promoteAutoPreviewLabel,
		).toBe(true);
	});

	it("enables the preview read proxy and archive-on-teardown only when flagged", () => {
		expect(getApplicationAdapterConfig({}).previewReadProxyEnabled).toBe(false);
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
		expect(getApplicationAdapterConfig({}).previewRunFeedEnabled).toBe(false);
		expect(
			getApplicationAdapterConfig({ PREVIEW_RUN_FEED_ENABLED: "true" }).previewRunFeedEnabled,
		).toBe(true);
		expect(
			getApplicationAdapterConfig({ PREVIEW_RUN_FEED_ENABLED: "off" }).previewRunFeedEnabled,
		).toBe(false);
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
			previewRunFeedEnabled: false,
			prPreviewsEnabled: false,
			prPreviewRepo: "PittampalliOrg/workflow-builder",
			vclusterPreviewMax: 6,
			prPreviewVerifyEnabled: false,
			promoteAutoPreviewLabel: false,
			previewReadProxyEnabled: false,
			previewArchiveOnTeardownEnabled: false,
		});
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
			getApplicationAdapterConfig({ APP_PROFILE: "lite", EVENT_BUS_ADAPTER: "bogus" }),
		).toThrow("Unsupported EVENT_BUS_ADAPTER='bogus'");
	});

	it("rejects an unknown APP_PROFILE", () => {
		expect(() => getApplicationAdapterConfig({ APP_PROFILE: "prod" })).toThrow(
			"Unsupported APP_PROFILE='prod'",
		);
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
			getApplicationAdapterConfig({ SCRIPT_CALLS_STORE_ADAPTER: "raw-sql" }),
		).toThrow("Unsupported SCRIPT_CALLS_STORE_ADAPTER='raw-sql'");
	});
});
