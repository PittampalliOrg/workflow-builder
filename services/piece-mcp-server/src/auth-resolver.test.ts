import { beforeEach, describe, expect, it, vi } from "vitest";

import {
	clearAuthCache,
	resolveAuth,
	runWithRequestAuthContext,
} from "./auth-resolver";

function clearAuthEnv(): void {
	delete process.env.INTERNAL_API_URL;
	delete process.env.INTERNAL_API_TOKEN;
	delete process.env.CONNECTION_EXTERNAL_ID;
	delete process.env.CREDENTIALS_JSON;
}

describe("resolveAuth", () => {
	beforeEach(() => {
		vi.restoreAllMocks();
		vi.unstubAllGlobals();
		clearAuthCache();
		clearAuthEnv();
	});

	it("resolves credentials from the request connection external id", async () => {
		process.env.INTERNAL_API_URL = "http://workflow-builder.test";
		process.env.INTERNAL_API_TOKEN = "internal-token";
		const fetchMock = vi.fn(async () =>
			new Response(JSON.stringify({ value: { access_token: "token-1" } }), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			}),
		);
		vi.stubGlobal("fetch", fetchMock);

		const auth = await runWithRequestAuthContext(
			{ connectionExternalId: "conn_1" },
			() => resolveAuth(),
		);

		expect(auth).toEqual({ access_token: "token-1" });
		expect(fetchMock).toHaveBeenCalledWith(
			"http://workflow-builder.test/api/internal/connections/conn_1/decrypt",
			expect.objectContaining({
				headers: expect.objectContaining({
					"X-Internal-Token": "internal-token",
				}),
			}),
		);
	});

	it("does not fall back to a service-wide connection env var", async () => {
		process.env.INTERNAL_API_URL = "http://workflow-builder.test";
		process.env.INTERNAL_API_TOKEN = "internal-token";
		process.env.CONNECTION_EXTERNAL_ID = "conn_env";
		const fetchMock = vi.fn();
		vi.stubGlobal("fetch", fetchMock);

		const auth = await resolveAuth();

		expect(auth).toBeUndefined();
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("does not fall back to inline credential JSON", async () => {
		process.env.CREDENTIALS_JSON = JSON.stringify({ access_token: "inline" });

		await expect(resolveAuth()).resolves.toBeUndefined();
	});
});
