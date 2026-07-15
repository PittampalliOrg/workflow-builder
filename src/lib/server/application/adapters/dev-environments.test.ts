import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { PostgresDevEnvironmentReadRepository } from "./dev-environments";

function queryReturning(rows: unknown[]) {
	const query = {
		from: vi.fn(),
		innerJoin: vi.fn(),
		where: vi.fn(),
		orderBy: vi.fn(),
		limit: vi.fn(async () => rows),
		then: (resolve: (value: unknown[]) => unknown) =>
			Promise.resolve(rows).then(resolve),
	};
	query.from.mockReturnValue(query);
	query.innerJoin.mockReturnValue(query);
	query.where.mockReturnValue(query);
	query.orderBy.mockReturnValue(query);
	return query;
}

function databaseReturning(...results: unknown[][]) {
	const select = vi.fn();
	for (const rows of results)
		select.mockReturnValueOnce(queryReturning(rows));
	return { select };
}

const SANDBOX_NAME = "wfb-dev-preview-workflow-builder-exec-1";
const createdAt = new Date("2026-07-11T12:00:00.000Z");

function tombstoneRow(overrides: Record<string, unknown> = {}) {
	return {
		workspaceRef: SANDBOX_NAME,
		sandboxState: {
			details: {
				kind: "dev-preview",
				executionId: "exec-1",
				service: "workflow-builder",
				sandboxName: SANDBOX_NAME,
				port: 3000,
				needsDapr: true,
			},
		},
		createdAt,
		runStatus: "success",
		...overrides,
	};
}

function activePreviewRow(service = "function-router") {
	return {
		workspaceRef: `wfb-dev-preview-${service}-exec-1`,
		executionId: "exec-1",
		sandboxState: {
			details: {
				kind: "dev-preview",
				executionId: "exec-1",
				service,
				sandboxName: `wfb-dev-preview-${service}-exec-1`,
				podIP: "10.0.0.8",
				port: service === "workflow-builder" ? 3000 : 8080,
				ready: true,
				needsDapr: true,
			},
		},
		createdAt,
		runStatus: "running",
	};
}

describe("PostgresDevEnvironmentReadRepository pending cardinality", () => {
	it("keeps canonical requested order before any preview row is persisted", async () => {
		const database = databaseReturning(
			[],
			[
				{
					id: "exec-1",
					status: "running",
					input: {
						services: [
							" function-router ",
							"workflow-builder",
							"function-router",
							"unknown-service",
						],
					},
					createdAt,
				},
			],
			[{ id: "session-1" }],
		);
		const repository = new PostgresDevEnvironmentReadRepository(
			database as never,
		);

		await expect(
			repository.getDevEnvironmentOrPending({
				executionId: "exec-1",
				projectId: "project-1",
			}),
		).resolves.toMatchObject({
			service: "function-router",
			ready: false,
			sessionId: "session-1",
			requestedServices: ["function-router", "workflow-builder"],
		});
		expect(database.select).toHaveBeenCalledTimes(3);
	});

	it("falls back to legacy input.service", async () => {
		const database = databaseReturning(
			[],
			[
				{
					id: "exec-1",
					status: "running",
					input: { service: "workflow-orchestrator" },
					createdAt,
				},
			],
			[],
		);
		const repository = new PostgresDevEnvironmentReadRepository(
			database as never,
		);

		await expect(
			repository.getDevEnvironmentOrPending({
				executionId: "exec-1",
				projectId: "project-1",
			}),
		).resolves.toMatchObject({
			service: "workflow-orchestrator",
			requestedServices: ["workflow-orchestrator"],
		});
	});

	it("adds requested services to a partially persisted environment without changing readiness", async () => {
		const persisted = activePreviewRow();
		const database = databaseReturning(
			[persisted],
			[],
			[
				{
					id: "exec-1",
					status: "running",
					input: {
						services: [
							"function-router",
							"workflow-builder",
							"mcp-gateway",
						],
					},
					createdAt,
				},
			],
		);
		const repository = new PostgresDevEnvironmentReadRepository(
			database as never,
		);

		await expect(
			repository.getDevEnvironmentOrPending({
				executionId: "exec-1",
				projectId: "project-1",
			}),
		).resolves.toMatchObject({
			service: "function-router",
			workspaceRef: persisted.workspaceRef,
			ready: true,
			podIP: "10.0.0.8",
			requestedServices: [
				"function-router",
				"workflow-builder",
				"mcp-gateway",
			],
		});
		expect(database.select).toHaveBeenCalledTimes(3);
	});
});

describe("PostgresDevEnvironmentReadRepository teardown tombstone", () => {
	it("reads an exact cleaned preview for a terminal execution", async () => {
		const database = databaseReturning(
			[
				tombstoneRow({
					workspaceRef: "unrelated-workspace",
					sandboxState: { details: { kind: "interactive-session" } },
				}),
				tombstoneRow(),
			],
			[{ id: "session-1" }],
		);
		const repository = new PostgresDevEnvironmentReadRepository(
			database as never,
		);

		await expect(
			repository.getDevEnvironmentTeardownTarget({
				executionId: "exec-1",
				projectId: "project-1",
			}),
		).resolves.toMatchObject({
			executionId: "exec-1",
			workspaceRef: SANDBOX_NAME,
			service: "workflow-builder",
			sandboxName: SANDBOX_NAME,
			sessionId: "session-1",
			runStatus: "success",
			ready: false,
			createdAt: createdAt.toISOString(),
		});
		expect(database.select).toHaveBeenCalledTimes(2);
	});

	it("ignores malformed or cross-execution preview rows", async () => {
		const wrongExecution = tombstoneRow({
			sandboxState: {
				details: {
					kind: "dev-preview",
					executionId: "exec-2",
					service: "workflow-builder",
					sandboxName: SANDBOX_NAME,
				},
			},
		});
		const malformedName = tombstoneRow({ workspaceRef: "malformed-name" });
		const database = databaseReturning([wrongExecution, malformedName]);
		const repository = new PostgresDevEnvironmentReadRepository(
			database as never,
		);

		await expect(
			repository.getDevEnvironmentTeardownTarget({
				executionId: "exec-1",
				projectId: "project-1",
			}),
		).resolves.toBeNull();
		expect(database.select).toHaveBeenCalledOnce();
	});

	it("requires a project scope before reading a tombstone", async () => {
		const database = databaseReturning([tombstoneRow()]);
		const repository = new PostgresDevEnvironmentReadRepository(
			database as never,
		);

		await expect(
			repository.getDevEnvironmentTeardownTarget({
				executionId: "exec-1",
				projectId: null,
			}),
		).resolves.toBeNull();
		expect(database.select).not.toHaveBeenCalled();
	});

	it("scopes cleaned-row lookup through the owning workflow project", () => {
		const source = readFileSync(
			join(
				dirname(fileURLToPath(import.meta.url)),
				"dev-environments.ts",
			),
			"utf8",
		);

		expect(source).toContain("eq(workflows.projectId, input.projectId)");
		expect(source).toContain(
			'eq(workflowWorkspaceSessions.status, "cleaned")',
		);
		expect(source).toContain("details.executionId !== input.executionId");
	});
});
