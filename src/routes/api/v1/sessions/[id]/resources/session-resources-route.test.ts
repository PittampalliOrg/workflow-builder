import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it, vi } from "vitest";

const listSessionResourcesMock = vi.fn();
const addSessionResourceMock = vi.fn();

vi.mock("$lib/server/application", () => ({
	getApplicationAdapters: () => ({
		workflowData: {
			listSessionResources: (...args: unknown[]) =>
				listSessionResourcesMock(...args),
		},
		sessionCommands: {
			addSessionResource: (...args: unknown[]) =>
				addSessionResourceMock(...args),
		},
	}),
}));

import { GET, POST } from "./+server";

describe("session resources route", () => {
	beforeEach(() => {
		listSessionResourcesMock.mockReset();
		addSessionResourceMock.mockReset();
		listSessionResourcesMock.mockResolvedValue([]);
		addSessionResourceMock.mockResolvedValue({
			status: "created",
			resource: sampleResource(),
		});
	});

	it("routes resource reads and writes through application services", () => {
		const source = readFileSync(
			join(dirname(fileURLToPath(import.meta.url)), "+server.ts"),
			"utf8",
		);

		expect(source).toContain("getApplicationAdapters");
		expect(source).toContain("workflowData.listSessionResources");
		expect(source).toContain("sessionCommands.addSessionResource");
		expect(source).toContain("projectId: locals.session.projectId");
		expect(source).toContain("userId: locals.session.userId");
		expect(source).not.toContain("$lib/server/sessions/registry");
		expect(source).not.toContain("$lib/server/sessions/repositories");
		expect(source).not.toContain("$lib/server/sandboxes/provision");
		expect(source).not.toContain("$lib/server/db");
		expect(source).not.toContain("drizzle-orm");
		expect(source).not.toContain("mountSingleRepository");
		expect(source).not.toContain("provisionSessionSandboxWithRetry");
		expect(source).not.toMatch(
			/import\s*\{[^}]*\b(addResource|getSession|listResources)\b[^}]*\}\s*from\s*["']\$lib\/server\/sessions\/registry["']/,
		);
	});

	it("delegates GET resource reads to workflow-data", async () => {
		const response = (await GET(
			sessionEvent("http://localhost/api/v1/sessions/session-1/resources"),
		)) as Response;
		const body = await response.json();

		expect(response.status).toBe(200);
		expect(body).toEqual({ resources: [] });
		expect(listSessionResourcesMock).toHaveBeenCalledWith({
			sessionId: "session-1",
			projectId: "project-1",
			userId: "user-1",
		});
	});

	it("delegates POST resource creation to session commands", async () => {
		const requestBody = {
			type: "github_repository",
			repoUrl: "https://github.com/PittampalliOrg/workflow-builder",
		};

		const response = (await POST(
			sessionEvent(
				"http://localhost/api/v1/sessions/session-1/resources",
				requestBody,
			),
		)) as Response;
		const body = await response.json();

		expect(response.status).toBe(201);
		expect(body).toEqual({ resource: sampleResource() });
		expect(addSessionResourceMock).toHaveBeenCalledWith({
			sessionId: "session-1",
			projectId: "project-1",
			userId: "user-1",
			body: requestBody,
		});
	});
});

function sessionEvent(url: string, body?: Record<string, unknown>): never {
	return {
		params: { id: "session-1" },
		request: new Request(url, {
			method: body ? "POST" : "GET",
			headers: { "content-type": "application/json" },
			body: body ? JSON.stringify(body) : undefined,
		}),
		locals: {
			session: {
				userId: "user-1",
				projectId: "project-1",
			},
		},
	} as never;
}

function sampleResource() {
	return {
		id: "resource-1",
		sessionId: "session-1",
		type: "github_repository",
		fileId: null,
		mountPath: null,
		repoUrl: "https://github.com/PittampalliOrg/workflow-builder",
		checkoutRef: null,
		authTokenCredentialId: null,
		appConnectionExternalId: null,
		mountedAt: null,
		removedAt: null,
	};
}
