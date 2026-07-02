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

describe("getApplicationAdapters", () => {
	it("does not initialize Postgres when only Dapr-backed ports are read", () => {
		const app = getApplicationAdapters();

		expect(app.eventBus).toBeTruthy();
		expect(app.workflowScheduler).toBeTruthy();
		expect(app.credentialStore).toBeTruthy();
		expect(requirePostgresDb).not.toHaveBeenCalled();
	});

	it("initializes Postgres only when a Postgres-backed port is read", () => {
		const app = getApplicationAdapters();

		expect(() => app.workflowDefinitions).toThrow("Database should be initialized lazily");
		expect(requirePostgresDb).toHaveBeenCalledTimes(1);
	});
});
