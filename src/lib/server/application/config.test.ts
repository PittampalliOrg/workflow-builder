import { describe, expect, it } from "vitest";
import { getApplicationAdapterConfig } from "$lib/server/application/config";

describe("application adapter config", () => {
	it("uses current production adapters by default", () => {
		expect(getApplicationAdapterConfig({})).toEqual({
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
});
