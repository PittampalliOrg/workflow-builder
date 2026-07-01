import { beforeEach, describe, expect, it, vi } from "vitest";

const daprFetchMock = vi.fn();

vi.mock("$lib/server/dapr-client", () => ({
	daprFetch: (...args: unknown[]) => daprFetchMock(...args),
	getDaprSidecarUrl: () => "http://localhost:3500",
}));

import {
	DaprCredentialStore,
	DaprEventBus,
} from "$lib/server/application/adapters/dapr";

describe("DaprCredentialStore", () => {
	beforeEach(() => {
		daprFetchMock.mockReset();
	});

	it("loads a secret from the selected Dapr secret store", async () => {
		daprFetchMock.mockResolvedValueOnce(
			Response.json({ "API-KEY": "secret-value" }),
		);

		const store = new DaprCredentialStore("kubernetes-secrets");
		await expect(store.resolveSecret("API-KEY")).resolves.toEqual({
			"API-KEY": "secret-value",
		});

		expect(daprFetchMock).toHaveBeenCalledWith(
			"http://localhost:3500/v1.0/secrets/kubernetes-secrets/API-KEY",
			{ signal: undefined, maxRetries: 0 },
		);
	});

	it("encodes secret store and secret names", async () => {
		daprFetchMock.mockResolvedValueOnce(Response.json({ value: "ok" }));

		const store = new DaprCredentialStore("store/name");
		await store.resolveSecret("secret/key");

		expect(String(daprFetchMock.mock.calls[0][0])).toBe(
			"http://localhost:3500/v1.0/secrets/store%2Fname/secret%2Fkey",
		);
	});

	it("fails closed on missing secret names and upstream failures", async () => {
		const store = new DaprCredentialStore("kubernetes-secrets");

		await expect(store.resolveSecret(" ")).rejects.toThrow(
			"Secret name is required",
		);

		daprFetchMock.mockResolvedValueOnce(new Response("missing", { status: 404 }));
		await expect(store.resolveSecret("NOPE")).rejects.toThrow(
			"Dapr secret lookup failed (404): missing",
		);
	});
});

describe("DaprEventBus", () => {
	beforeEach(() => {
		daprFetchMock.mockReset();
	});

	it("publishes to the configured Dapr pubsub component", async () => {
		daprFetchMock.mockResolvedValueOnce(new Response(null, { status: 204 }));

		const bus = new DaprEventBus("preview-pubsub");
		await bus.publish("workflow.triggers", { dedupKey: "k1" });

		expect(daprFetchMock).toHaveBeenCalledWith(
			"http://localhost:3500/v1.0/publish/preview-pubsub/workflow.triggers",
			{
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ dedupKey: "k1" }),
			},
		);
	});
});
