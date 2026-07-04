/**
 * Contract test: replays the shared wire fixtures in
 * services/shared/workflow-data-contract/fixtures against the real route
 * handlers (application port mocked) and asserts each response
 * superset-matches the fixture's responseBody.
 *
 * The same fixtures drive the orchestrator's WorkflowDataClient contract
 * section in services/workflow-orchestrator/tests/
 * test_workflow_data_activity_migration.py — see the README in the fixture
 * directory for the additive-only contract rules.
 */

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

type ContractFixture = {
	description: string;
	method: string;
	pathTemplate: string;
	path: string;
	pathParams: Record<string, string>;
	queryParams?: Record<string, string>;
	requestBody: Record<string, unknown> | null;
	responseBody: Record<string, unknown>;
};

const FIXTURE_DIR = join(process.cwd(), "services/shared/workflow-data-contract/fixtures");

function loadFixtures(): Record<string, ContractFixture> {
	const out: Record<string, ContractFixture> = {};
	for (const file of readdirSync(FIXTURE_DIR)) {
		if (!file.endsWith(".json")) continue;
		out[file.replace(/\.json$/, "")] = JSON.parse(
			readFileSync(join(FIXTURE_DIR, file), "utf8"),
		) as ContractFixture;
	}
	return out;
}

const fixtures = loadFixtures();

const mocks = vi.hoisted(() => {
	const workflowData = {
		getWorkflowByRef: vi.fn(),
		getExecutionById: vi.fn(),
		assertExecutionReadModelReady: vi.fn(),
		getExecutionByDaprInstanceId: vi.fn(),
		createWorkflowExecution: vi.fn(),
		getLiveExecutionInstance: vi.fn(),
		attachExecutionSchedulerInstance: vi.fn(),
		markExecutionStartFailed: vi.fn(),
		listStaleRunningExecutions: vi.fn(),
		updateExecutionReadModel: vi.fn(),
		appendExecutionLog: vi.fn(),
		updateExecutionLog: vi.fn(),
		upsertWorkflowArtifact: vi.fn(),
		upsertWorkflowWorkspaceSession: vi.fn(),
		resolveMcpConfig: vi.fn(),
		upsertScheduledAgentRun: vi.fn(),
		updateAgentRunLifecycle: vi.fn(),
		upsertPlanArtifact: vi.fn(),
		updatePlanArtifactStatus: vi.fn(),
		getPlanArtifact: vi.fn(),
		getTraceTargetsForExecution: vi.fn(),
		upsertTraceLineageLinks: vi.fn(),
	};
	return { workflowData, requireInternal: vi.fn() };
});

vi.mock("$lib/server/application", () => ({
	getApplicationAdapters: () => ({ workflowData: mocks.workflowData }),
}));

vi.mock("$lib/server/internal-auth", () => ({
	requireInternal: mocks.requireInternal,
}));

import { GET as getWorkflow } from "./workflows/[workflowRef]/+server";
import { GET as getStaleExecutions, POST as postExecution } from "./executions/+server";
import { GET as getExecution, PATCH as patchExecution } from "./executions/[executionId]/+server";
import { GET as getExecutionByInstance } from "./executions/by-instance/[instanceId]/+server";
import { GET as getReadModelReady } from "./executions/read-model-ready/+server";
import { GET as getLiveExecutionInstance } from "./executions/[executionId]/live-instance/+server";
import { POST as postSchedulerInstance } from "./executions/[executionId]/scheduler-instance/+server";
import { POST as postStartFailed } from "./executions/[executionId]/start-failed/+server";
import { POST as postExecutionLog } from "./executions/[executionId]/logs/+server";
import { PATCH as patchExecutionLog } from "./executions/[executionId]/logs/[logId]/+server";
import { POST as postWorkflowArtifact } from "./executions/[executionId]/artifacts/+server";
import { POST as postWorkspaceSession } from "./workspace-sessions/+server";
import { POST as postMcpResolve } from "./mcp/resolve/+server";
import { POST as postAgentRun } from "./agent-runs/+server";
import { PATCH as patchAgentRun } from "./agent-runs/[runId]/+server";
import { POST as postPlanArtifact } from "./plan-artifacts/+server";
import { GET as getPlanArtifact, PATCH as patchPlanArtifact } from "./plan-artifacts/[artifactRef]/+server";
import { GET as getTraceTargets } from "./traces/executions/[executionId]/targets/+server";
import { POST as postTraceLineage } from "./traces/lineage/+server";

type RouteHandler = (event: never) => Promise<Response>;

function requestEvent(fixture: ContractFixture) {
	const url = new URL(`http://workflow-builder.internal${fixture.path}`);
	return {
		params: fixture.pathParams,
		url,
		request: new Request(url, {
			method: fixture.method,
			body: fixture.requestBody === null ? undefined : JSON.stringify(fixture.requestBody),
			headers:
				fixture.requestBody === null ? undefined : { "Content-Type": "application/json" },
		}),
	} as never;
}

/** Route handlers respond with `{ ok: true, ...serviceResult }`. */
function withoutOk(body: Record<string, unknown>): Record<string, unknown> {
	const { ok: _ok, ...rest } = body;
	return rest;
}

function expectSuperset(actual: unknown, expected: unknown, path = "$"): void {
	if (expected === null || typeof expected !== "object") {
		expect(actual, path).toEqual(expected);
		return;
	}
	if (Array.isArray(expected)) {
		expect(Array.isArray(actual), `${path} should be an array`).toBe(true);
		expect((actual as unknown[]).length, `${path} length`).toBeGreaterThanOrEqual(
			expected.length,
		);
		expected.forEach((item, index) => {
			expectSuperset((actual as unknown[])[index], item, `${path}[${index}]`);
		});
		return;
	}
	expect(actual, `${path} should be an object`).toBeTypeOf("object");
	expect(actual, `${path} should not be null`).not.toBeNull();
	for (const [key, value] of Object.entries(expected)) {
		expect(actual, `${path}.${key} missing`).toHaveProperty(key);
		expectSuperset((actual as Record<string, unknown>)[key], value, `${path}.${key}`);
	}
}

/**
 * Per-fixture wiring: which handler serves the fixture and how to arrange the
 * mocked workflowData port so the route can produce the fixture response.
 */
const CONTRACT: Record<string, { handler: RouteHandler; arrange: (f: ContractFixture) => void }> =
	{
		"get-workflow": {
			handler: getWorkflow,
			arrange: (f) => mocks.workflowData.getWorkflowByRef.mockResolvedValue(f.responseBody.workflow),
		},
		"get-execution": {
			handler: getExecution,
			arrange: (f) => mocks.workflowData.getExecutionById.mockResolvedValue(f.responseBody.execution),
		},
		"read-model-ready": {
			handler: getReadModelReady,
			arrange: () => mocks.workflowData.assertExecutionReadModelReady.mockResolvedValue(undefined),
		},
		"get-execution-by-instance": {
			handler: getExecutionByInstance,
			arrange: (f) =>
				mocks.workflowData.getExecutionByDaprInstanceId.mockResolvedValue(f.responseBody.execution),
		},
		"create-execution": {
			handler: postExecution,
			arrange: (f) => mocks.workflowData.createWorkflowExecution.mockResolvedValue(f.responseBody),
		},
		"get-live-execution-instance": {
			handler: getLiveExecutionInstance,
			arrange: (f) =>
				mocks.workflowData.getLiveExecutionInstance.mockResolvedValue(f.responseBody.instance),
		},
		"attach-scheduler-instance": {
			handler: postSchedulerInstance,
			arrange: () =>
				mocks.workflowData.attachExecutionSchedulerInstance.mockResolvedValue(undefined),
		},
		"mark-start-failed": {
			handler: postStartFailed,
			arrange: () => mocks.workflowData.markExecutionStartFailed.mockResolvedValue(undefined),
		},
		"list-stale-executions": {
			handler: getStaleExecutions,
			arrange: (f) =>
				mocks.workflowData.listStaleRunningExecutions.mockResolvedValue(f.responseBody.executions),
		},
		"patch-execution": {
			handler: patchExecution,
			arrange: (f) => {
				mocks.workflowData.getExecutionById.mockResolvedValue({
					id: f.pathParams.executionId,
				});
				mocks.workflowData.updateExecutionReadModel.mockResolvedValue(undefined);
			},
		},
		"append-execution-log": {
			handler: postExecutionLog,
			arrange: (f) => {
				mocks.workflowData.getExecutionById.mockResolvedValue({
					id: f.pathParams.executionId,
				});
				mocks.workflowData.appendExecutionLog.mockResolvedValue(f.responseBody.log);
			},
		},
		"update-execution-log": {
			handler: patchExecutionLog,
			arrange: (f) => {
				mocks.workflowData.getExecutionById.mockResolvedValue({
					id: f.pathParams.executionId,
				});
				mocks.workflowData.updateExecutionLog.mockResolvedValue(f.responseBody.log);
			},
		},
		"upsert-workflow-artifact": {
			handler: postWorkflowArtifact,
			arrange: () => mocks.workflowData.upsertWorkflowArtifact.mockResolvedValue(undefined),
		},
		"upsert-workspace-session": {
			handler: postWorkspaceSession,
			arrange: (f) =>
				mocks.workflowData.upsertWorkflowWorkspaceSession.mockResolvedValue(
					withoutOk(f.responseBody),
				),
		},
		"resolve-mcp-config": {
			handler: postMcpResolve,
			arrange: (f) => mocks.workflowData.resolveMcpConfig.mockResolvedValue(f.responseBody),
		},
		"schedule-agent-run": {
			handler: postAgentRun,
			arrange: (f) =>
				mocks.workflowData.upsertScheduledAgentRun.mockResolvedValue(withoutOk(f.responseBody)),
		},
		"update-agent-run": {
			handler: patchAgentRun,
			arrange: (f) =>
				mocks.workflowData.updateAgentRunLifecycle.mockResolvedValue(withoutOk(f.responseBody)),
		},
		"upsert-plan-artifact": {
			handler: postPlanArtifact,
			arrange: (f) =>
				mocks.workflowData.upsertPlanArtifact.mockResolvedValue(withoutOk(f.responseBody)),
		},
		"update-plan-artifact": {
			handler: patchPlanArtifact,
			arrange: (f) =>
				mocks.workflowData.updatePlanArtifactStatus.mockResolvedValue(withoutOk(f.responseBody)),
		},
		"get-plan-artifact": {
			handler: getPlanArtifact,
			arrange: (f) => mocks.workflowData.getPlanArtifact.mockResolvedValue(f.responseBody.artifact),
		},
		"get-trace-targets": {
			handler: getTraceTargets,
			arrange: (f) =>
				mocks.workflowData.getTraceTargetsForExecution.mockResolvedValue(f.responseBody.targets),
		},
		"upsert-trace-lineage": {
			handler: postTraceLineage,
			arrange: (f) =>
				mocks.workflowData.upsertTraceLineageLinks.mockResolvedValue(withoutOk(f.responseBody)),
		},
	};

describe("workflow-data wire contract (shared fixtures)", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("covers every fixture with a handler mapping and vice versa", () => {
		expect(Object.keys(CONTRACT).sort()).toEqual(Object.keys(fixtures).sort());
	});

	for (const [name, fixture] of Object.entries(fixtures)) {
		it(`${name}: ${fixture.method} ${fixture.pathTemplate}`, async () => {
			const entry = CONTRACT[name];
			expect(entry, `no CONTRACT entry for fixture ${name}`).toBeDefined();
			entry.arrange(fixture);

			const response = await entry.handler(requestEvent(fixture));
			expect(response.status, `${name} should succeed`).toBe(200);
			expectSuperset(await response.json(), fixture.responseBody);
		});
	}
});
