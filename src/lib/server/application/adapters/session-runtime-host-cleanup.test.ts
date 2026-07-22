import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	ApplicationSessionRuntimeHostCleanupService,
	CoalescingTerminalRuntimeHostCleanupRunner,
} from "../session-runtime-host-cleanup";
import { CurrentSessionRepository } from "./sessions";

const NOW = new Date("2026-07-22T12:00:00.000Z");
const AVAILABLE_BEFORE = new Date("2026-07-22T11:59:00.000Z");

describe("CurrentSessionRepository terminal runtime-host cleanup", () => {
	let client: PGlite;
	let repository: CurrentSessionRepository;

	beforeEach(async () => {
		client = new PGlite();
		await client.exec(`
			CREATE TABLE workflows (
				id text PRIMARY KEY,
				engine_type text
			);
			CREATE TABLE workflow_executions (
				id text PRIMARY KEY,
				workflow_id text NOT NULL,
				status text NOT NULL
			);
			CREATE TABLE sessions (
				id text PRIMARY KEY,
				status text NOT NULL,
				dapr_instance_id text,
				runtime_app_id text,
				runtime_sandbox_name text,
				runtime_host_owned boolean NOT NULL DEFAULT true,
				runtime_host_cleanup_completed_at timestamp,
				runtime_host_cleanup_attempted_at timestamp,
				workflow_execution_id text,
				completed_at timestamp,
				updated_at timestamp NOT NULL DEFAULT now()
			);
			CREATE TABLE workflow_script_calls (
				workflow_execution_id text NOT NULL,
				call_id text NOT NULL,
				status text NOT NULL,
				session_id text,
				PRIMARY KEY (workflow_execution_id, call_id)
			);
			CREATE TABLE workflow_agent_runs (
				id text PRIMARY KEY,
				workflow_execution_id text NOT NULL,
				agent_workflow_id text NOT NULL,
				status text NOT NULL
			);
			INSERT INTO workflows (id, engine_type) VALUES
				('workflow-dapr', 'dapr'),
				('workflow-script', 'dynamic-script');
			INSERT INTO workflow_executions (id, workflow_id, status) VALUES
				('execution-dapr', 'workflow-dapr', 'running'),
				('execution-script', 'workflow-script', 'running'),
				('execution-script-other', 'workflow-script', 'running');
			INSERT INTO sessions (
				id, status, dapr_instance_id, runtime_app_id, runtime_sandbox_name,
				runtime_host_owned, workflow_execution_id, completed_at
			) VALUES
				('pydantic-terminal', 'terminated', 'pydantic-terminal',
				 'agent-session-pydantic', 'agent-host-agent-session-pydantic',
				 true, 'execution-dapr', '2026-07-22T11:00:00Z'),
				('native-before-run-row', 'terminated', 'native-before-run-row',
				 'agent-session-native-race', 'agent-host-agent-session-native-race',
				 true, 'execution-dapr', '2026-07-22T11:01:00Z'),
				('cli-awaiting-parent', 'terminated', 'cli-awaiting-parent',
				 'agent-session-cli', 'agent-host-agent-session-cli',
				 true, 'execution-script', '2026-07-22T11:02:00Z'),
				('script-before-journal', 'terminated', 'script-before-journal',
				 'agent-session-race', 'agent-host-agent-session-race',
				 true, 'execution-script', '2026-07-22T11:03:00Z'),
				('shared-terminal', 'terminated', 'shared-terminal',
				 'dapr-agent-py', null, false, 'execution-dapr', '2026-07-22T11:04:00Z'),
				('turn-failure', 'failed', 'turn-failure',
				 'agent-session-failed', 'agent-host-agent-session-failed',
				 true, 'execution-dapr', null);
			INSERT INTO workflow_agent_runs (
				id, workflow_execution_id, agent_workflow_id, status
			) VALUES (
				'pydantic-terminal', 'execution-dapr', 'pydantic-terminal', 'completed'
			);
			INSERT INTO workflow_script_calls (
				workflow_execution_id, call_id, status, session_id
			) VALUES
				('execution-script', 'call-cli', 'running', 'cli-awaiting-parent'),
				('execution-script-other', 'foreign-terminal', 'done', 'script-before-journal'),
				('execution-script-other', 'foreign-running', 'running', 'cli-awaiting-parent');
		`);
		repository = new CurrentSessionRepository(drizzle(client) as never);
	});

	afterEach(async () => {
		await client.close();
	});

	function list(
		input: Omit<
			Parameters<
				CurrentSessionRepository["listPendingTerminalRuntimeHostCleanups"]
			>[0],
			"availableBefore"
		>,
	) {
		return repository.listPendingTerminalRuntimeHostCleanups({
			...input,
			availableBefore: AVAILABLE_BEFORE,
		});
	}

	it("selects a consumed native result while preserving the script fence", async () => {
		await expect(list({ limit: 20 })).resolves.toEqual([
			{
				sessionId: "pydantic-terminal",
				runtimeAppId: "agent-session-pydantic",
				instanceId: "pydantic-terminal",
				runtimeSandboxName: "agent-host-agent-session-pydantic",
			},
		]);
		await expect(
			list({ workflowExecutionId: "execution-script", limit: 20 }),
		).resolves.toEqual([]);
	});

	it("correlates script journals to the owning execution", async () => {
		await expect(
			list({ sessionId: "script-before-journal", limit: 1 }),
		).resolves.toEqual([]);

		await client.exec(`
			UPDATE workflow_script_calls
			SET status = 'done'
			WHERE workflow_execution_id = 'execution-script' AND call_id = 'call-cli'
		`);
		await expect(
			list({ sessionId: "cli-awaiting-parent", limit: 1 }),
		).resolves.toEqual([
			{
				sessionId: "cli-awaiting-parent",
				runtimeAppId: "agent-session-cli",
				instanceId: "cli-awaiting-parent",
				runtimeSandboxName: "agent-host-agent-session-cli",
			},
		]);
	});

	it("keeps a skipped script child until runtime closure is confirmed", async () => {
		await client.exec(`
			UPDATE workflow_script_calls
			SET status = 'skipped'
			WHERE workflow_execution_id = 'execution-script' AND call_id = 'call-cli'
		`);
		let now = NOW;
		const inspectRuntimeInstance = vi
			.fn()
			.mockResolvedValueOnce("active")
			.mockResolvedValueOnce("terminal");
		const deleteRuntimeSandbox = vi.fn(async (name: string) => ({
			name,
			kind: "runtime" as const,
			status: "missing" as const,
		}));
		const service = new ApplicationSessionRuntimeHostCleanupService({
			sessions: repository,
			runtimeInspector: { inspectRuntimeInstance },
			sandboxes: { deleteRuntimeSandbox },
			now: () => now,
		});

		await expect(
			service.reapPending({ sessionId: "cli-awaiting-parent", limit: 1 }),
		).resolves.toMatchObject({
			acknowledged: [],
			failed: [
				{
					sessionId: "cli-awaiting-parent",
					error: "runtime instance is still active",
				},
			],
		});
		expect(deleteRuntimeSandbox).not.toHaveBeenCalled();

		now = new Date(NOW.getTime() + 60_001);
		await expect(
			service.reapPending({ sessionId: "cli-awaiting-parent", limit: 1 }),
		).resolves.toMatchObject({ acknowledged: ["cli-awaiting-parent"] });
		expect(deleteRuntimeSandbox).toHaveBeenCalledOnce();
	});

	it("does not treat an empty dynamic journal as consumed before dispatch", async () => {
		await expect(
			list({ sessionId: "script-before-journal", limit: 1 }),
		).resolves.toEqual([]);

		await client.exec(`
			UPDATE workflow_executions
			SET status = 'success'
			WHERE id = 'execution-script'
		`);
		await expect(
			list({ sessionId: "script-before-journal", limit: 1 }),
		).resolves.toEqual([
			{
				sessionId: "script-before-journal",
				runtimeAppId: "agent-session-race",
				instanceId: "script-before-journal",
				runtimeSandboxName: "agent-host-agent-session-race",
			},
		]);
	});

	it("does not treat an empty native run journal as parent consumption", async () => {
		await expect(
			list({ sessionId: "native-before-run-row", limit: 1 }),
		).resolves.toEqual([]);

		await client.exec(`
			INSERT INTO workflow_agent_runs (
				id, workflow_execution_id, agent_workflow_id, status
			) VALUES (
				'native-before-run-row', 'execution-dapr',
				'native-before-run-row', 'completed'
			)
		`);
		await expect(
			list({ sessionId: "native-before-run-row", limit: 1 }),
		).resolves.toEqual([
			{
				sessionId: "native-before-run-row",
				runtimeAppId: "agent-session-native-race",
				instanceId: "native-before-run-row",
				runtimeSandboxName: "agent-host-agent-session-native-race",
			},
		]);
	});

	it("eagerly reaps a native host after its terminal run row closes the fence", async () => {
		await expect(
			list({ sessionId: "native-before-run-row", limit: 1 }),
		).resolves.toEqual([]);
		const deleteRuntimeSandbox = vi.fn(async (name: string) => ({
			name,
			kind: "runtime" as const,
			status: "deleted" as const,
		}));
		const service = new ApplicationSessionRuntimeHostCleanupService({
			sessions: repository,
			runtimeInspector: {
				inspectRuntimeInstance: vi.fn(async () => "terminal" as const),
			},
			sandboxes: { deleteRuntimeSandbox },
			eagerRunner: new CoalescingTerminalRuntimeHostCleanupRunner(),
			now: () => NOW,
		});

		await client.exec(`
			INSERT INTO workflow_agent_runs (
				id, workflow_execution_id, agent_workflow_id, status
			) VALUES (
				'native-before-run-row', 'execution-dapr',
				'native-before-run-row', 'completed'
			)
		`);
		service.requestReap();

		await vi.waitFor(async () => {
			const result = await client.query<{
				runtime_host_cleanup_completed_at: Date | null;
			}>(`
				SELECT runtime_host_cleanup_completed_at
				FROM sessions
				WHERE id = 'native-before-run-row'
			`);
			expect(result.rows[0]?.runtime_host_cleanup_completed_at).toBeInstanceOf(
				Date,
			);
		});
		expect(deleteRuntimeSandbox).toHaveBeenCalledWith(
			"agent-host-agent-session-native-race",
		);
	});

	it("uses the session id as the migrated-row runtime instance fallback", async () => {
		await client.exec(`
			INSERT INTO sessions (
				id, status, dapr_instance_id, runtime_app_id,
				runtime_sandbox_name, runtime_host_owned, completed_at
			) VALUES (
				'legacy-null-dapr', 'terminated', null, 'agent-legacy',
				'agent-host-agent-legacy', true, '2026-07-22T11:20:00Z'
			)
		`);
		const inspectRuntimeInstance = vi.fn(async () => "not_found" as const);
		const service = new ApplicationSessionRuntimeHostCleanupService({
			sessions: repository,
			runtimeInspector: { inspectRuntimeInstance },
			sandboxes: {
				deleteRuntimeSandbox: vi.fn(async (name) => ({
					name,
					kind: "runtime" as const,
					status: "missing" as const,
				})),
			},
			now: () => NOW,
		});

		await expect(
			service.reapPending({ sessionId: "legacy-null-dapr", limit: 1 }),
		).resolves.toMatchObject({ acknowledged: ["legacy-null-dapr"] });
		expect(inspectRuntimeInstance).toHaveBeenCalledWith({
			runtimeAppId: "agent-legacy",
			instanceId: "legacy-null-dapr",
			runtimeSandboxName: "agent-host-agent-legacy",
		});
	});

	it("claims one exact runtime identity and retries only after the lease", async () => {
			const claim = {
				sessionId: "pydantic-terminal",
				runtimeAppId: "agent-session-pydantic",
				instanceId: "pydantic-terminal",
				runtimeSandboxName: "agent-host-agent-session-pydantic",
				attemptedAt: NOW,
			availableBefore: AVAILABLE_BEFORE,
		};
		const claims = await Promise.all([
			repository.claimTerminalRuntimeHostCleanup(claim),
			repository.claimTerminalRuntimeHostCleanup(claim),
		]);
		expect(claims.filter(Boolean)).toHaveLength(1);
		await expect(list({ sessionId: "pydantic-terminal", limit: 1 })).resolves.toEqual(
			[],
		);
		await expect(
			repository.listPendingTerminalRuntimeHostCleanups({
				sessionId: "pydantic-terminal",
				limit: 1,
				availableBefore: new Date(NOW.getTime() + 1),
			}),
		).resolves.toHaveLength(1);
	});

	it("acknowledges exact runtime identity idempotently", async () => {
		await expect(
			repository.acknowledgeTerminalRuntimeHostCleanup({
				sessionId: "pydantic-terminal",
					runtimeAppId: "agent-session-pydantic",
					instanceId: "wrong-instance",
					runtimeSandboxName: "agent-host-agent-session-pydantic",
					completedAt: NOW,
			}),
		).resolves.toBe(false);
		const exact = {
			sessionId: "pydantic-terminal",
				runtimeAppId: "agent-session-pydantic",
				instanceId: "pydantic-terminal",
				runtimeSandboxName: "agent-host-agent-session-pydantic",
				completedAt: NOW,
		};
		await expect(
			repository.acknowledgeTerminalRuntimeHostCleanup(exact),
		).resolves.toBe(true);
		await expect(
			repository.acknowledgeTerminalRuntimeHostCleanup(exact),
		).resolves.toBe(false);
		await expect(list({ sessionId: "pydantic-terminal", limit: 1 })).resolves.toEqual(
			[],
		);
	});

	it("does not claim or acknowledge after the sandbox target changes", async () => {
		const candidate = (
			await list({ sessionId: "pydantic-terminal", limit: 1 })
		)[0];
		expect(candidate).toBeDefined();
		await client.exec(`
			UPDATE sessions
			SET runtime_sandbox_name = 'agent-host-agent-session-replaced'
			WHERE id = 'pydantic-terminal'
		`);

		await expect(
			repository.claimTerminalRuntimeHostCleanup({
				...candidate!,
				attemptedAt: NOW,
				availableBefore: AVAILABLE_BEFORE,
			}),
		).resolves.toBe(false);
		await expect(
			repository.acknowledgeTerminalRuntimeHostCleanup({
				...candidate!,
				completedAt: NOW,
			}),
		).resolves.toBe(false);
	});

	it("rotates permanent failures so the ninth candidate runs on the next pass", async () => {
		await client.exec(`
			UPDATE sessions
			SET runtime_host_cleanup_completed_at = '2026-07-22T11:45:00Z'
		`);
		const values = Array.from({ length: 9 }, (_, index) => {
			const id = `fair-${index}`;
			return `('${id}', 'terminated', '${id}', 'agent-${id}', 'agent-host-agent-${id}', true, '2026-07-22T11:30:00Z')`;
		}).join(",");
		await client.exec(`
			INSERT INTO sessions (
				id, status, dapr_instance_id, runtime_app_id,
				runtime_sandbox_name, runtime_host_owned, completed_at
			) VALUES ${values}
		`);
		const deleteRuntimeSandbox = vi.fn(async (name: string) => ({
			name,
			kind: "runtime" as const,
			status: "error" as const,
			error: "permanent provider failure",
		}));
		const service = new ApplicationSessionRuntimeHostCleanupService({
			sessions: repository,
			runtimeInspector: {
				inspectRuntimeInstance: vi.fn(async () => "terminal" as const),
			},
			sandboxes: { deleteRuntimeSandbox },
			now: () => NOW,
		});

		await expect(service.reapPending({ limit: 8 })).resolves.toMatchObject({
			scanned: 9,
			acknowledged: [],
			failed: expect.any(Array),
		});
		expect(deleteRuntimeSandbox).toHaveBeenCalledTimes(8);

		await expect(service.reapPending({ limit: 8 })).resolves.toMatchObject({
			scanned: 1,
			acknowledged: [],
			failed: [expect.objectContaining({ error: "permanent provider failure" })],
		});
		expect(deleteRuntimeSandbox).toHaveBeenCalledTimes(9);
	});
});
