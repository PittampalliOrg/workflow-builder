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
			previewRunFeedEnabled: false,
		});
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
			previewRunFeedEnabled: false,
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
});
