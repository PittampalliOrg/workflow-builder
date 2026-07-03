import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
	UpdateWorkflowTriggerLifecycleStateInput,
	WorkflowTriggerRecord,
	WorkflowTriggerStore,
} from "$lib/server/application/ports";
import {
	type TriggerBackingPort,
	WorkflowTriggerLifecycleReconciler,
} from "$lib/server/lifecycle/trigger-reconciler";

describe("WorkflowTriggerLifecycleReconciler", () => {
	let trigger: WorkflowTriggerRecord;
	let triggers: Pick<WorkflowTriggerStore, "getById" | "updateLifecycleState">;
	let backing: TriggerBackingPort;

	beforeEach(() => {
		trigger = triggerRecord();
		triggers = {
			getById: vi.fn(async () => trigger),
			updateLifecycleState: vi.fn(async (_input) => undefined),
		};
		backing = {
			provision: vi.fn(async () => ({
				backingRef: "backing-1",
				configPatch: { secretName: "trigger-secret" },
			})) as TriggerBackingPort["provision"],
			deprovision: vi.fn(
				async () => undefined,
			) as TriggerBackingPort["deprovision"],
		};
	});

	it("activates a backing trigger through the trigger store port", async () => {
		const reconciler = new WorkflowTriggerLifecycleReconciler({
			triggers,
			backing,
		});

		await expect(reconciler.activateTrigger("trigger-1")).resolves.toEqual({
			ok: true,
			status: "active",
		});

		expect(backing.provision).toHaveBeenCalledWith({
			triggerId: "trigger-1",
			workflowId: "wf-1",
			kind: "webhook",
			config: { path: "/trigger" },
			backingRef: null,
		});
		expect(updateCalls()).toEqual([
			{ triggerId: "trigger-1", status: "activating" },
			{
				triggerId: "trigger-1",
				status: "active",
				backingRef: "backing-1",
				lastError: null,
				config: { path: "/trigger", secretName: "trigger-secret" },
			},
		]);
	});

	it("marks non-backed triggers active without provisioning", async () => {
		trigger = triggerRecord({ kind: "manual" });
		const reconciler = new WorkflowTriggerLifecycleReconciler({
			triggers,
			backing,
		});

		await expect(reconciler.activateTrigger("trigger-1")).resolves.toEqual({
			ok: true,
			status: "active",
		});

		expect(backing.provision).not.toHaveBeenCalled();
		expect(updateCalls()).toEqual([{ triggerId: "trigger-1", status: "active", lastError: null }]);
	});

	it("deactivates backed triggers and clears backing state", async () => {
		trigger = triggerRecord({ backingRef: "backing-1", status: "active" });
		const reconciler = new WorkflowTriggerLifecycleReconciler({
			triggers,
			backing,
		});

		await expect(reconciler.deactivateTrigger("trigger-1")).resolves.toEqual({
			ok: true,
			status: "inactive",
		});

		expect(backing.deprovision).toHaveBeenCalledWith({
			triggerId: "trigger-1",
			kind: "webhook",
			backingRef: "backing-1",
		});
		expect(updateCalls()).toEqual([
			{ triggerId: "trigger-1", status: "deactivating" },
			{
				triggerId: "trigger-1",
				status: "inactive",
				backingRef: null,
				lastError: null,
			},
		]);
	});

	it("keeps trigger lifecycle reconciliation independent of DB infrastructure", () => {
		const source = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "trigger-reconciler.ts"), "utf8");

		expect(source).not.toContain("$lib/server/db");
		expect(source).not.toContain("$lib/server/db/schema");
		expect(source).not.toContain("drizzle-orm");
	});

	function updateCalls(): UpdateWorkflowTriggerLifecycleStateInput[] {
		return vi.mocked(triggers.updateLifecycleState).mock.calls.map(([input]) => input);
	}
});

function triggerRecord(overrides: Partial<WorkflowTriggerRecord> = {}): WorkflowTriggerRecord {
	return {
		id: "trigger-1",
		workflowId: "wf-1",
		userId: "user-1",
		projectId: "project-1",
		kind: "webhook",
		config: { path: "/trigger" },
		triggerData: null,
		dedupSalt: "salt",
		backingRef: null,
		status: "inactive",
		lastError: null,
		lastFiredAt: null,
		createdAt: new Date("2026-01-01T00:00:00.000Z"),
		updatedAt: new Date("2026-01-01T00:00:00.000Z"),
		...overrides,
	};
}
