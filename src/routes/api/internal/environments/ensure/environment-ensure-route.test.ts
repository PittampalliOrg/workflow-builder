import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
	class MockSwebenchEnvironmentEnsureRequestError extends Error {
		constructor(
			readonly status: number,
			message: string,
		) {
			super(message);
			this.name = "SwebenchEnvironmentEnsureRequestError";
		}
	}
	return {
		requireInternal: vi.fn(),
		ensureSwebenchEnvironmentFromInternalRequest: vi.fn(),
		SwebenchEnvironmentEnsureRequestError:
			MockSwebenchEnvironmentEnsureRequestError,
	};
});

vi.mock("$lib/server/internal-auth", () => ({
	requireInternal: mocks.requireInternal,
}));

vi.mock("$lib/server/environments/swebench-environment-ensure", () => ({
	SwebenchEnvironmentEnsureRequestError:
		mocks.SwebenchEnvironmentEnsureRequestError,
	ensureSwebenchEnvironmentFromInternalRequest:
		mocks.ensureSwebenchEnvironmentFromInternalRequest,
}));

import { SwebenchEnvironmentEnsureRequestError } from "$lib/server/environments/swebench-environment-ensure";
import { POST } from "./+server";

describe("internal environment ensure route", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mocks.ensureSwebenchEnvironmentFromInternalRequest.mockResolvedValue({
			success: true,
			complete: true,
			environmentStatus: "validated",
			status: "validated",
			sandboxTemplate: "dapr-agent",
		});
	});

	it("delegates SWE-bench environment preparation to the use case", async () => {
		const body = {
			dataset: "SWE-bench_Verified",
			instanceId: "astropy__astropy-7166",
			repo: "astropy/astropy",
			baseCommit: "abc123",
			allowBuild: true,
		};

		const response = (await POST({
			request: new Request("http://localhost", {
				method: "POST",
				body: JSON.stringify(body),
			}),
		} as never)) as Response;
		const payload = await response.json();

		expect(response.status).toBe(200);
		expect(mocks.requireInternal).toHaveBeenCalledTimes(1);
		expect(mocks.ensureSwebenchEnvironmentFromInternalRequest).toHaveBeenCalledWith(body);
		expect(payload).toEqual({
			success: true,
			complete: true,
			environmentStatus: "validated",
			status: "validated",
			sandboxTemplate: "dapr-agent",
		});
	});

	it("maps use-case request errors to HTTP errors", async () => {
		mocks.ensureSwebenchEnvironmentFromInternalRequest.mockRejectedValue(
			new SwebenchEnvironmentEnsureRequestError(409, "metadata missing"),
		);

		await expect(
			POST({
				request: new Request("http://localhost", {
					method: "POST",
					body: JSON.stringify({}),
				}),
			} as never),
		).rejects.toMatchObject({
			status: 409,
			body: {
				message: "metadata missing",
			},
		});
	});

	it("keeps the route free of direct DB imports", () => {
		const source = readFileSync(
			join(dirname(fileURLToPath(import.meta.url)), "+server.ts"),
			"utf8",
		);

		expect(source).toContain("ensureSwebenchEnvironmentFromInternalRequest");
		expect(source).not.toContain("$lib/server/db");
		expect(source).not.toContain("$lib/server/db/schema");
		expect(source).not.toContain("drizzle-orm");
		expect(source).not.toContain("benchmarkInstances");
		expect(source).not.toContain("benchmarkSuites");
	});
});
