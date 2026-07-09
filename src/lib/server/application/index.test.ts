import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";

vi.mock("$lib/server/application/adapters/postgres", () => ({
	requirePostgresDb: vi.fn(() => {
		throw new Error("Database should be initialized lazily");
	}),
	PostgresArtifactStore: vi.fn(),
	PostgresTraceLineageStore: vi.fn(),
	PostgresWorkflowAgentRunStore: vi.fn(),
	PostgresWorkspaceSessionStore: vi.fn(),
	PostgresWorkflowPlanArtifactStore: vi.fn(),
	PostgresWorkflowDefinitionRepository: vi.fn(),
	PostgresWorkflowExecutionRepository: vi.fn(),
	PostgresWorkspaceProjectRepository: vi.fn(),
	PostgresPieceCatalogRepository: vi.fn(),
	PostgresBenchmarkBrowserRepository: vi.fn(),
	PostgresBenchmarkRunRepository: vi.fn(),
	PostgresMcpConnectionRepository: vi.fn(),
	PostgresHostedMcpServerRepository: vi.fn(),
	PostgresMcpRunRepository: vi.fn(),
	PostgresAppConnectionRepository: vi.fn(),
	PostgresUserProfileRepository: vi.fn(),
	PostgresSettingsRepository: vi.fn(),
	PostgresAdminPieceRepository: vi.fn(),
}));

import { getApplicationAdapters } from "$lib/server/application";
import { requirePostgresDb } from "$lib/server/application/adapters/postgres";
import { getApplicationAdapterConfig } from "$lib/server/application/config";
import {
	InProcessEventBus,
	LiteStubWorkflowScheduler,
} from "$lib/server/application/adapters/in-process";

describe("getApplicationAdapters", () => {
	it("does not initialize Postgres when only Dapr-backed ports are read", () => {
		const app = getApplicationAdapters();

		expect(app.eventBus).toBeTruthy();
		expect(app.workflowScheduler).toBeTruthy();
		expect(app.credentialStore).toBeTruthy();
		expect(requirePostgresDb).not.toHaveBeenCalled();
	});

	it("wires the in-process bus and lite-stub scheduler in the lite profile", () => {
		const app = getApplicationAdapters(getApplicationAdapterConfig({ APP_PROFILE: "lite" }));

		expect(app.eventBus).toBeInstanceOf(InProcessEventBus);
		expect(app.workflowScheduler).toBeInstanceOf(LiteStubWorkflowScheduler);
		expect(requirePostgresDb).not.toHaveBeenCalled();
	});

	it("fails fast when an unwired staged Dapr product-data adapter is selected", () => {
		expect(() =>
			getApplicationAdapters(
				getApplicationAdapterConfig({
					WORKFLOW_DEFINITIONS_STORE_ADAPTER: "dapr-postgres-binding",
				}),
			),
		).toThrow(
			"Dapr PostgreSQL binding adapters are not wired for: WORKFLOW_DEFINITIONS_STORE_ADAPTER",
		);
	});

	it("initializes Postgres only when a Postgres-backed port is read", () => {
		const app = getApplicationAdapters();

		expect(() => app.workflowDefinitions).toThrow("Database should be initialized lazily");
		expect(requirePostgresDb).toHaveBeenCalledTimes(1);
	});

	it("wires session goal persistence through an injected Postgres adapter", () => {
		const source = readFileSync(
			join(dirname(fileURLToPath(import.meta.url)), "index.ts"),
			"utf8",
		);

		expect(source).toContain("new PostgresSessionGoalStore(getDatabase())");
		expect(source).toContain("new PostgresSessionEventLog(getDatabase())");
		expect(source).toContain("new PostgresGoalLoopStore(getDatabase)");
		expect(source).toContain("new DaprSessionGoalLoopDriver(getGoalLoopStore())");
		expect(source).toContain("new PostgresLifecycleCoordinatorOwnerStore(getDatabase)");
		expect(source).toContain("new LifecycleSessionController(");
		expect(source).toContain("getLifecycleCoordinatorOwners()");
		expect(source).not.toContain("RepositorySessionGoalStore");
	});
});
