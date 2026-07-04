import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
	const environments = {
		resolveRuntimeBySlug: vi.fn(async () => ({
			environment: {
				id: "env-1",
				slug: "dapr-agent",
				version: 2,
				imageTag: "ghcr.io/test/dapr-agent:latest",
				imageSource: "translated",
				imageResolutionWarning: null,
				baseEnvSlug: null,
				config: {
					sandboxMode: "per-run",
					keepAfterRun: true,
					ttlSeconds: 900,
					networking: { type: "unrestricted" },
					capabilities: ["python", "mcp"],
				},
			},
		})),
	};
	const validateInternalToken = vi.fn(() => true);
	return { environments, validateInternalToken };
});

vi.mock("$lib/server/application", () => ({
	getApplicationAdapters: () => ({ environments: mocks.environments }),
}));

vi.mock("$lib/server/internal-auth", () => ({
	validateInternalToken: mocks.validateInternalToken,
}));

import { GET } from "./+server";

describe("/api/internal/environments/resolve route", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mocks.validateInternalToken.mockReturnValue(true);
		mocks.environments.resolveRuntimeBySlug.mockResolvedValue({
			environment: {
				id: "env-1",
				slug: "dapr-agent",
				version: 2,
				imageTag: "ghcr.io/test/dapr-agent:latest",
				imageSource: "translated",
				imageResolutionWarning: null,
				baseEnvSlug: null,
				config: {
					sandboxMode: "per-run",
					keepAfterRun: true,
					ttlSeconds: 900,
					networking: { type: "unrestricted" },
					capabilities: ["python", "mcp"],
				},
			},
		});
	});

	it("keeps runtime environment resolution behind the application service", () => {
		const source = readFileSync(
			join(dirname(fileURLToPath(import.meta.url)), "+server.ts"),
			"utf8",
		);
		expect(source).toContain("getApplicationAdapters");
		expect(source).toContain("environments.resolveRuntimeBySlug");
		expect(source).not.toContain("$lib/server/environments/registry");
		expect(source).not.toContain("$lib/server/db");
		expect(source).not.toContain("drizzle-orm");
	});

	it("returns the openshell runtime resolution payload", async () => {
		const request = new Request(
			"http://test/api/internal/environments/resolve?slug=dapr-agent",
		);
		const response = (await GET({
			url: new URL(request.url),
			request,
		} as never)) as Response;

		expect(response.status).toBe(200);
		await expect(response.json()).resolves.toEqual({
			id: "env-1",
			slug: "dapr-agent",
			version: 2,
			imageTag: "ghcr.io/test/dapr-agent:latest",
			imageSource: "translated",
			imageResolutionWarning: null,
			baseEnvSlug: null,
			sandboxMode: "per-run",
			keepAfterRun: true,
			ttlSeconds: 900,
			networking: { type: "unrestricted" },
			capabilities: ["python", "mcp"],
		});
		expect(mocks.environments.resolveRuntimeBySlug).toHaveBeenCalledWith({
			slug: "dapr-agent",
		});
	});

	it("maps application errors to status responses", async () => {
		mocks.environments.resolveRuntimeBySlug.mockRejectedValueOnce(
			Object.assign(new Error("slug query param required"), { status: 400 }),
		);
		const request = new Request("http://test/api/internal/environments/resolve");
		const response = (await GET({
			url: new URL(request.url),
			request,
		} as never)) as Response;

		expect(response.status).toBe(400);
		await expect(response.json()).resolves.toEqual({
			error: "slug query param required",
		});
	});

	it("rejects requests without the internal token", async () => {
		mocks.validateInternalToken.mockReturnValueOnce(false);
		const request = new Request(
			"http://test/api/internal/environments/resolve?slug=dapr-agent",
		);
		const response = (await GET({
			url: new URL(request.url),
			request,
		} as never)) as Response;

		expect(response.status).toBe(401);
		expect(mocks.environments.resolveRuntimeBySlug).not.toHaveBeenCalled();
	});
});
