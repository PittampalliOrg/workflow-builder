import { describe, expect, it } from "vitest";
import { getEventBusAdapter } from "$lib/server/application/event-bus";
import { getApplicationAdapterConfig } from "$lib/server/application/config";
import { InProcessEventBus } from "$lib/server/application/adapters/in-process";
import { DaprEventBus } from "$lib/server/application/adapters/dapr";

describe("getEventBusAdapter", () => {
	it("returns the Dapr bus for the full profile default", () => {
		expect(getEventBusAdapter(getApplicationAdapterConfig({}))).toBeInstanceOf(DaprEventBus);
	});

	it("returns a shared in-process bus in the lite profile", () => {
		const config = getApplicationAdapterConfig({ APP_PROFILE: "lite" });
		const a = getEventBusAdapter(config);
		const b = getEventBusAdapter(config);
		expect(a).toBeInstanceOf(InProcessEventBus);
		expect(a).toBe(b);
	});

	it("throws on an unsupported event bus adapter value", () => {
		expect(() =>
			getEventBusAdapter({
				appProfile: "full",
				persistenceAdapter: "postgres",
				eventBusAdapter: "bogus" as never,
				artifactStoreAdapter: "postgres-metadata-object-data",
				workflowSchedulerAdapter: "dapr-workflow",
				previewProvisionerAdapter: "sandbox-execution-api",
				previewRunFeedEnabled: false,
				prPreviewsEnabled: false,
				prPreviewVerifyEnabled: false,
				promoteAutoPreviewLabel: false,
			}),
		).toThrow("Unsupported event bus adapter: bogus");
	});
});
