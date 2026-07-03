import { describe, expect, it, vi } from "vitest";
import { PostgresLifecycleCoordinatorOwnerStore } from "$lib/server/application/adapters/lifecycle-ownership";

describe("PostgresLifecycleCoordinatorOwnerStore", () => {
	it("returns benchmark owners before checking evaluation ownership", async () => {
		const database = queuedDatabase([{ runId: "bench-1" }]);
		const store = new PostgresLifecycleCoordinatorOwnerStore(
			() => database as never,
		);

		await expect(store.getCoordinatorOwner("exec-1")).resolves.toEqual({
			kind: "benchmarkRun",
			runId: "bench-1",
		});
		expect(database.select).toHaveBeenCalledTimes(1);
	});

	it("falls back to evaluation ownership when no benchmark owner exists", async () => {
		const database = queuedDatabase([], [{ runId: "eval-1" }]);
		const store = new PostgresLifecycleCoordinatorOwnerStore(
			() => database as never,
		);

		await expect(store.getCoordinatorOwner("instance-1")).resolves.toEqual({
			kind: "evalRun",
			runId: "eval-1",
		});
		expect(database.select).toHaveBeenCalledTimes(2);
	});

	it("resolves session ownership through the session execution candidates", async () => {
		const database = queuedDatabase(
			[{ workflowExecutionId: "exec-1", daprInstanceId: "instance-1" }],
			[],
			[{ runId: "eval-1" }],
		);
		const store = new PostgresLifecycleCoordinatorOwnerStore(
			() => database as never,
		);

		await expect(store.getSessionCoordinatorOwner("session-1")).resolves.toEqual({
			kind: "evalRun",
			runId: "eval-1",
		});
		expect(database.select).toHaveBeenCalledTimes(3);
	});

	it("does not initialize the database for blank ids", async () => {
		const getDatabase = vi.fn(() => queuedDatabase() as never);
		const store = new PostgresLifecycleCoordinatorOwnerStore(getDatabase);

		await expect(store.getCoordinatorOwner("  ")).resolves.toBeNull();
		await expect(store.getSessionCoordinatorOwner("")).resolves.toBeNull();
		expect(getDatabase).not.toHaveBeenCalled();
	});
});

function queuedDatabase(...resultSets: Array<Array<Record<string, unknown>>>) {
	const select = vi.fn(() => {
		const result = resultSets.shift() ?? [];
		const query = {
			from: vi.fn(() => query),
			where: vi.fn(() => query),
			limit: vi.fn(async () => result),
		};
		return query;
	});
	return { select } as never as {
		select: ReturnType<typeof vi.fn>;
	};
}
